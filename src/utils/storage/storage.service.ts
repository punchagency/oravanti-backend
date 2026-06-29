import { R2StorageService } from "./r2.storage-service";
import type { BaseStorageService } from "./storage.types";

function createStorageService(): BaseStorageService {
  return new R2StorageService();
}

export const storageService = createStorageService();
