import { randomUUID } from 'crypto';
import { store } from './store.service';

export interface ProfileMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  config: any; // StoreSchema['config']
}

export function getActiveProfileId(): string {
  const id = store.get('currentProfileId', '');
  if (!id) {
    // Should not happen after migration, but safety fallback
    const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
    const ids = Object.keys(profiles);
    if (ids.length > 0) {
      store.set('currentProfileId', ids[0]);
      return ids[0];
    }
  }
  return id;
}

export function listProfiles(): ProfileMeta[] {
  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  return Object.values(profiles).map((p) => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

export function switchProfile(id: string): void {
  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  if (!profiles[id]) {
    throw new Error(`Profile ${id} does not exist`);
  }
  store.set('currentProfileId', id);
}

export function createProfile({ name, cloneCurrent }: { name: string; cloneCurrent: boolean }): ProfileMeta {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Profile name cannot be empty');
  }
  const existing = listProfiles();
  if (existing.some((p) => p.name === trimmedName)) {
    throw new Error(`A profile named "${trimmedName}" already exists`);
  }

  const id = `profile-${randomUUID()}`;
  const now = new Date().toISOString();

  let config = store.get('config'); // default fallback
  let encryptedKeys: Record<string, string> = {};

  if (cloneCurrent) {
    const activeId = getActiveProfileId();
    const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
    const activeProfile = profiles[activeId];
    if (activeProfile) {
      config = JSON.parse(JSON.stringify(activeProfile.config)); // deep clone
      const allEncrypted = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
      encryptedKeys = { ...(allEncrypted[activeId] || {}) };
    }
  }

  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  profiles[id] = {
    id,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
    config,
  };
  store.set('profiles', profiles);

  const allEncrypted = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
  allEncrypted[id] = encryptedKeys;
  store.set('encryptedApiKeysByProfile', allEncrypted);

  return { id, name: trimmedName, createdAt: now, updatedAt: now };
}

export function renameProfile(id: string, name: string): void {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Profile name cannot be empty');
  }
  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  if (!profiles[id]) {
    throw new Error(`Profile ${id} does not exist`);
  }
  const existing = Object.values(profiles).find((p) => p.name === trimmedName && p.id !== id);
  if (existing) {
    throw new Error(`A profile named "${trimmedName}" already exists`);
  }
  profiles[id] = { ...profiles[id], name: trimmedName, updatedAt: new Date().toISOString() };
  store.set('profiles', profiles);
}

export function duplicateProfile(id: string, newName: string): ProfileMeta {
  const trimmedName = newName.trim();
  if (!trimmedName) {
    throw new Error('Profile name cannot be empty');
  }
  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  const source = profiles[id];
  if (!source) {
    throw new Error(`Profile ${id} does not exist`);
  }
  const existing = Object.values(profiles).find((p) => p.name === trimmedName);
  if (existing) {
    throw new Error(`A profile named "${trimmedName}" already exists`);
  }

  const newId = `profile-${randomUUID()}`;
  const now = new Date().toISOString();

  profiles[newId] = {
    id: newId,
    name: trimmedName,
    createdAt: now,
    updatedAt: now,
    config: JSON.parse(JSON.stringify(source.config)),
  };
  store.set('profiles', profiles);

  const allEncrypted = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
  allEncrypted[newId] = { ...(allEncrypted[id] || {}) };
  store.set('encryptedApiKeysByProfile', allEncrypted);

  return { id: newId, name: trimmedName, createdAt: now, updatedAt: now };
}

export function deleteProfile(id: string): void {
  const currentId = getActiveProfileId();
  if (id === currentId) {
    throw new Error('Cannot delete the current profile');
  }
  const profiles = store.get('profiles', {}) as Record<string, ProfileEntry>;
  const ids = Object.keys(profiles);
  if (ids.length <= 1) {
    throw new Error('Cannot delete the only profile');
  }
  if (!profiles[id]) {
    throw new Error(`Profile ${id} does not exist`);
  }
  delete profiles[id];
  store.set('profiles', profiles);

  const allEncrypted = store.get('encryptedApiKeysByProfile', {}) as Record<string, Record<string, string>>;
  delete allEncrypted[id];
  store.set('encryptedApiKeysByProfile', allEncrypted);
}
