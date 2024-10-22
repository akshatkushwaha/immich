import 'dart:async';

import 'package:drift/drift.dart';
import 'package:immich_mobile/domain/entities/store.entity.drift.dart';
import 'package:immich_mobile/domain/interfaces/store.interface.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/repositories/database.repository.dart';
import 'package:immich_mobile/utils/mixins/log.mixin.dart';

class StoreRepository with LogMixin implements IStoreRepository {
  final DriftDatabaseRepository _db;

  const StoreRepository({required DriftDatabaseRepository db}) : _db = db;

  @override
  Future<T?> tryGet<T, U>(StoreKey<T, U> key) async {
    final storeData = await _db.managers.store
        .filter((s) => s.id.equals(key.id))
        .getSingleOrNull();
    return _getValueFromStoreData(key, storeData);
  }

  @override
  Future<T> get<T, U>(StoreKey<T, U> key) async {
    final value = await tryGet(key);
    if (value == null) {
      throw StoreKeyNotFoundException(key);
    }
    return value;
  }

  @override
  Future<bool> upsert<T, U>(StoreKey<T, U> key, T value) async {
    try {
      final storeValue = key.converter.toPrimitive(value);
      final intValue = (key.type == int) ? storeValue as int : null;
      final stringValue = (key.type == String) ? storeValue as String : null;
      await _db.store.insertOnConflictUpdate(StoreCompanion.insert(
        id: Value(key.id),
        intValue: Value(intValue),
        stringValue: Value(stringValue),
      ));
      return true;
    } catch (e, s) {
      log.e("Cannot set store value - ${key.name}; id - ${key.id}", e, s);
      return false;
    }
  }

  @override
  Future<void> delete(StoreKey key) async {
    await _db.managers.store.filter((s) => s.id.equals(key.id)).delete();
  }

  @override
  Stream<T?> watch<T, U>(StoreKey<T, U> key) {
    return _db.managers.store
        .filter((s) => s.id.equals(key.id))
        .watchSingleOrNull()
        .asyncMap((e) async => await _getValueFromStoreData(key, e));
  }

  @override
  Future<void> deleteAll() async {
    await _db.managers.store.delete();
  }

  Future<T?> _getValueFromStoreData<T, U>(
    StoreKey<T, U> key,
    StoreData? data,
  ) async {
    final primitive = switch (key.type) {
      const (int) => data?.intValue,
      const (String) => data?.stringValue,
      _ => null,
    } as U?;
    if (primitive != null) {
      return await key.converter.fromPrimitive(primitive);
    }
    return null;
  }
}