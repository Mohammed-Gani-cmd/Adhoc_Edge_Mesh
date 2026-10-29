import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { File, Paths } from 'expo-file-system';
import * as Device from 'expo-device';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { fetch as expoFetch } from 'expo/fetch';
import { Client } from './client.ts';
import type { NativeIO } from './transfers.ts';

export const nativeIO: NativeIO = {
  async pick() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 100, quality: 1,
    });
    return result.canceled ? null : result.assets;
  },
  async jpeg(uri, size) {
    const context = ImageManipulator.ImageManipulator.manipulate(uri);
    let image: ImageManipulator.ImageRef | undefined;
    try {
      if (size) context.resize(size);
      image = await context.renderAsync();
      const result = await image.saveAsync({ compress: 0.9, format: ImageManipulator.SaveFormat.JPEG });
      return result.uri;
    } finally { image?.release(); context.release(); }
  },
  size: uri => new File(uri).size,
  file: uri => new File(uri),
  async dimensions(uri) {
    // Read dimensions from the same renderer used to resize, including EXIF orientation.
    const context = ImageManipulator.ImageManipulator.manipulate(uri);
    let image: ImageManipulator.ImageRef | undefined;
    try {
      image = await context.renderAsync();
      return { width: image.width, height: image.height };
    } finally { image?.release(); context.release(); }
  },
  remove(uri) { const file = new File(uri); if (file.exists) file.delete(); },
  async download(url, filename, headers, signal) {
    const destination = new File(Paths.cache, `edge-${Crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
    try {
      const result = await File.createDownloadTask(url, destination, { headers, signal }).downloadAsync();
      if (!result) throw new Error('File download did not complete.');
      return result.uri;
    } catch (error) {
      // Android can leave partial downloads, including when a request is aborted.
      try { if (destination.exists) destination.delete(); } catch {}
      throw error;
    }
  },
  sharingAvailable: () => Sharing.isAvailableAsync(),
  share: uri => Sharing.shareAsync(uri, { mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: 'Save or share Edge Mesh results' }),
};

export function nativeClient(url: string, token: string) {
  return new Client(url, token, expoFetch);
}

export async function deviceMetadata() {
  const totalMemory = Math.max(512, Math.round((Device.totalMemory || 1024 * 1024 * 1024) / 1024 / 1024));
  let clientId = await SecureStore.getItemAsync('edge_mesh_worker_id');
  if (!clientId) {
    clientId = Crypto.randomUUID().replace(/-/g, '');
    await SecureStore.setItemAsync('edge_mesh_worker_id', clientId);
  }
  return {
    name: Device.modelName || 'Mobile phone', platform: Platform.OS, client_id: clientId,
    capacity: 1, cpu_percent: 0, total_memory_mb: totalMemory, free_memory_mb: Math.round(totalMemory * 0.5),
  };
}
