import type { Store } from '../domain/model.js';

export interface TransactionResult<T> {
  value: T;
  changed: boolean;
}

/** 回调只修改隔离副本，持久化成功后才发布新的状态。 */
export interface StoreRepository {
  read(): Promise<Store>;
  transact<T>(operation: (draft: Store) => TransactionResult<T>): Promise<T>;
  close(): Promise<void>;
}
