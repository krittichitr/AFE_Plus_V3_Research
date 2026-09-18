import type {
  SendTargetLocationInput,
  TargetSafezone,
  TargetSenderIdentity,
} from './types';

type ApiEnvelope = {
  message?: unknown;
  data?: unknown;
};

type TargetLocationPayload = {
  uId: number;
  takecare_id: number;
  distance: number;
  latitude: number;
  longitude: number;
  target_sample_id: string;
  battery: number;
};

type EncryptedPayload = {
  iv: string;
  ciphertext: string;
};

export class TargetSenderApiError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message);
    this.name = 'TargetSenderApiError';
  }
}

async function readJson(response: Response): Promise<ApiEnvelope> {
  try {
    return await response.json() as ApiEnvelope;
  } catch {
    return {};
  }
}

function numberField(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TargetSenderApiError(`ข้อมูล Safe Zone ไม่ถูกต้อง (${name})`);
  }
  return parsed;
}

function sharedKeyBytes(): Uint8Array {
  const hex = process.env.NEXT_PUBLIC_AES_SHARED_KEY;
  if (!hex || !/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new TargetSenderApiError(
      'ไม่ได้ตั้งค่า NEXT_PUBLIC_AES_SHARED_KEY เป็น hex 32 ตัวอักษรสำหรับ V3 Sender',
    );
  }

  return Uint8Array.from(
    hex.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

async function encryptTargetPayload(payload: TargetLocationPayload): Promise<EncryptedPayload> {
  if (!globalThis.crypto?.subtle) {
    throw new TargetSenderApiError('เบราว์เซอร์นี้ไม่รองรับ Web Crypto สำหรับ V3 Sender');
  }

  const iv = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedKeyBytes(),
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CBC', iv },
    key,
    plaintext,
  );

  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

export async function fetchTargetSafezone(
  identity: TargetSenderIdentity,
  signal?: AbortSignal,
): Promise<TargetSafezone> {
  const query = new URLSearchParams({
    users_id: String(identity.usersId),
    takecare_id: String(identity.takecareId),
  });
  const response = await fetch(`/api/setting/getSafezone?${query.toString()}`, { signal });
  const body = await readJson(response);

  if (!response.ok || body.message !== 'success' || !body.data || typeof body.data !== 'object') {
    throw new TargetSenderApiError('ไม่พบ Safe Zone สำหรับผู้ใช้งานนี้', response.status);
  }

  const row = body.data as Record<string, unknown>;
  const latitude = numberField(row.safez_latitude, 'latitude');
  const longitude = numberField(row.safez_longitude, 'longitude');

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new TargetSenderApiError('พิกัด Safe Zone อยู่นอกช่วงที่ถูกต้อง');
  }

  return { latitude, longitude };
}

export async function sendTargetLocation(input: SendTargetLocationInput): Promise<void> {
  const encryptedBody = await encryptTargetPayload({
    uId: input.identity.usersId,
    takecare_id: input.identity.takecareId,
    distance: input.distanceFromSafezoneM,
    latitude: input.sample.latitude,
    longitude: input.sample.longitude,
    target_sample_id: input.sample.targetSampleId,
    battery: input.batteryPercent,
  });
  const response = await fetch('/api/sentlocation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify(encryptedBody),
  });
  const body = await readJson(response);

  if (!response.ok || body.message !== 'success') {
    const detail = typeof body.data === 'string' ? `: ${body.data}` : '';
    throw new TargetSenderApiError(`ส่งตำแหน่งไม่สำเร็จ${detail}`, response.status);
  }
}
