//! FILENAME: app/src/core/lib/file-api.ts
import { tracedInvoke } from '../../utils/bridge';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { CellData } from '../types/types';
import { emitAppEvent, AppEvents } from './events';

const CALCULA_FILTER = {
  name: 'Calcula Workbook',
  extensions: ['cala'],
};

const XLSX_FILTER = {
  name: 'Excel Workbook',
  extensions: ['xlsx'],
};

const ALL_FILTER = {
  name: 'All Files',
  extensions: ['*'],
};

export async function saveFileAs(): Promise<string | null> {
  try {
    const path = await save({
      filters: [CALCULA_FILTER, XLSX_FILTER, ALL_FILTER],
      defaultPath: 'Workbook.cala',
    });

    if (path) {
      emitAppEvent(AppEvents.BEFORE_SAVE, { path });
      await tracedInvoke('save_file', { path });
      emitAppEvent(AppEvents.AFTER_SAVE, { path });
      return path;
    }
    return null;
  } catch (error) {
    console.error('[FILE] saveFileAs error:', error);
    throw error;
  }
}

export async function saveFile(): Promise<string | null> {
  try {
    const currentPath = await getCurrentFilePath();

    if (currentPath) {
      emitAppEvent(AppEvents.BEFORE_SAVE, { path: currentPath });
      await tracedInvoke('save_file', { path: currentPath });
      emitAppEvent(AppEvents.AFTER_SAVE, { path: currentPath });
      return currentPath;
    }

    return saveFileAs();
  } catch (error) {
    console.error('[FILE] saveFile error:', error);
    throw error;
  }
}

export async function openFile(): Promise<CellData[] | null> {
  try {
    const path = await open({
      filters: [CALCULA_FILTER, XLSX_FILTER, ALL_FILTER],
      multiple: false,
      directory: false,
    });

    if (path && typeof path === 'string') {
      emitAppEvent(AppEvents.BEFORE_OPEN, { path });
      const cells = await tracedInvoke<CellData[]>('open_file', { path });
      emitAppEvent(AppEvents.AFTER_OPEN, { path });
      return cells;
    }
    return null;
  } catch (error) {
    console.error('[FILE] openFile error:', error);
    throw error;
  }
}

export async function newFile(): Promise<void> {
  try {
    emitAppEvent(AppEvents.BEFORE_NEW);
    await tracedInvoke('new_file', {});
    emitAppEvent(AppEvents.AFTER_NEW);
  } catch (error) {
    console.error('[FILE] newFile error:', error);
    throw error;
  }
}

export async function getCurrentFilePath(): Promise<string | null> {
  return tracedInvoke<string | null>('get_current_file_path', {});
}

export async function isFileModified(): Promise<boolean> {
  return tracedInvoke<boolean>('is_file_modified', {});
}

export async function markFileModified(): Promise<void> {
  await tracedInvoke('mark_file_modified', {});
}