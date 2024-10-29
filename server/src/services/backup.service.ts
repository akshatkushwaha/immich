import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { default as path } from 'node:path';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent } from 'src/decorators';
import { ImmichWorker, StorageFolder } from 'src/enum';
import { DatabaseLock } from 'src/interfaces/database.interface';
import { ArgOf } from 'src/interfaces/event.interface';
import { JobName, JobStatus } from 'src/interfaces/job.interface';
import { BaseService } from 'src/services/base.service';
import { handlePromiseError } from 'src/utils/misc';
import { validateCronExpression } from 'src/validation';

@Injectable()
export class BackupService extends BaseService {
  private backupLock = false;

  @OnEvent({ name: 'app.bootstrap' })
  async onBootstrap(workerType: ImmichWorker) {
    if (workerType !== ImmichWorker.API) {
      return;
    }
    const {
      backup: { database },
    } = await this.getConfig({ withCache: true });

    this.backupLock = await this.databaseRepository.tryLock(DatabaseLock.BackupDatabase);

    if (this.backupLock) {
      this.jobRepository.addCronJob(
        'backupDatabase',
        database.cronExpression,
        () => handlePromiseError(this.jobRepository.queue({ name: JobName.BACKUP_DATABASE }), this.logger),
        database.enabled,
      );
    }
  }

  @OnEvent({ name: 'config.update', server: true })
  onConfigUpdate({ newConfig: { backup }, oldConfig }: ArgOf<'config.update'>) {
    if (!oldConfig || !this.backupLock) {
      return;
    }

    this.jobRepository.updateCronJob('backupDatabase', backup.database.cronExpression, backup.database.enabled);
  }

  @OnEvent({ name: 'config.validate' })
  onConfigValidate({ newConfig }: ArgOf<'config.validate'>) {
    const { database } = newConfig.backup;
    if (!validateCronExpression(database.cronExpression)) {
      throw new Error(`Invalid cron expression ${database.cronExpression}`);
    }
  }

  async cleanupDatabaseBackups() {
    this.logger.debug(`Database Backup Cleanup Started`);
    const {
      backup: { database: config },
    } = await this.getConfig({ withCache: false });

    const backupsFolder = StorageCore.getBaseFolder(StorageFolder.BACKUPS);
    const files = await this.storageRepository.readdir(backupsFolder);
    const failedBackups = files.filter((file) => file.match(/immich-db-backup-\d+\.sql\.gz\.tmp$/));
    const backups = files
      .filter((file) => {
        return file.match(/immich-db-backup-\d+\.sql\.gz$/);
      })
      .sort()
      .reverse();

    const toDelete = backups.slice(config.keepLastAmount);
    toDelete.push(...failedBackups);

    for (const file of toDelete) {
      await this.storageRepository.unlink(path.join(backupsFolder, file));
    }
    this.logger.debug(`Database Backup Cleanup Finished, deleted ${toDelete.length} backups`);
  }

  async handleBackupDatabase(): Promise<JobStatus> {
    this.logger.debug(`Database Backup Started`);

    const {
      database: { config },
    } = this.configRepository.getEnv();

    const isUrlConnection = config.connectionType === 'url';
    const databaseParams = isUrlConnection ? [config.url] : ['-U', config.username, '-h', config.host];

    try {
      await new Promise<void>((resolve, reject) => {
        const pgdump = spawn(`pg_dumpall`, [...databaseParams, '--clean', '--if-exists'], {
          env: { PATH: process.env.PATH, PGPASSWORD: isUrlConnection ? undefined : config.password },
        });

        const gzip = spawn(`gzip`, [], {
          stdio: [pgdump.stdout, 'pipe', 'pipe'],
        });

        const backupFilePath = path.join(
          StorageCore.getBaseFolder(StorageFolder.BACKUPS),
          `immich-db-backup-${Date.now()}.sql.gz.tmp`,
        );

        const fileStream = this.storageRepository.createWriteStream(backupFilePath);

        gzip.stdout.pipe(fileStream);

        if (!pgdump.stderr || !pgdump.stdout) {
          this.logger.error('Backup failed, could not spawn backup process');
          reject('Backup failed, could not spawn backup process');
          return;
        }

        if (!gzip.stderr || !gzip.stdout) {
          this.logger.error('Backup failed, could not spawn gzip process');
          reject('Backup failed, could not spawn gzip process');
          return;
        }

        pgdump.on('error', (err) => {
          this.logger.error('Backup failed with error', err);
          reject(err);
        });

        gzip.on('error', (err) => {
          this.logger.error('Gzip failed with error', err);
          reject(err);
        });

        let pgdumpLogs = '';
        let gzipLogs = '';

        pgdump.stderr.on('data', (data) => (pgdumpLogs += data));
        gzip.stderr.on('data', (data) => (gzipLogs += data));

        pgdump.on('exit', (code) => {
          if (code !== 0) {
            this.logger.error(`Backup failed with code ${code}`);
            reject(`Backup failed with code ${code}`);
            this.logger.error(pgdumpLogs);
            return;
          }
          if (pgdumpLogs) {
            this.logger.debug(`pgdump_all logs\n${pgdumpLogs}`);
          }
        });

        gzip.on('exit', (code) => {
          if (code !== 0) {
            this.logger.error(`Gzip failed with code ${code}`);
            reject(`Gzip failed with code ${code}`);
            this.logger.error(gzipLogs);
            return;
          }
          if (pgdump.exitCode !== 0) {
            this.logger.error(`Gzip exited with code 0 but pgdump exited with ${pgdump.exitCode}`);
            return;
          }
          this.storageRepository
            .rename(backupFilePath, backupFilePath.replace('.tmp', ''))
            .then(() => {
              resolve();
            })
            .catch((error) => {
              this.logger.error('Backup failed with error', error);
              reject(error);
            });
        });
      });
    } catch (error) {
      this.logger.error('Database Backup Failure', error);
      return JobStatus.FAILED;
    }

    this.logger.debug(`Database Backup Success`);
    await this.cleanupDatabaseBackups();
    return JobStatus.SUCCESS;
  }
}
