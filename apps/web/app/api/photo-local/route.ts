import { NextResponse, type NextRequest } from 'next/server';
import { localPhotoDir, readLocalPhoto, saveLocalUpload } from '@/lib/photo-local';

// Photos on this machine's disk where there is no bucket (lib/photo-local.ts): local development
// and e2e only. A deployed server has PHOTO_BUCKET, and then this answers 404.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!localPhotoDir()) return new NextResponse(null, { status: 404 });
  const ok = await saveLocalUpload(await req.formData()).catch(() => false);
  return new NextResponse(null, { status: ok ? 204 : 403 });
}

export async function GET(req: NextRequest) {
  if (!localPhotoDir()) return new NextResponse(null, { status: 404 });
  const photo = await readLocalPhoto(req.nextUrl.searchParams);
  if (!photo) return new NextResponse(null, { status: 403 });
  return new NextResponse(new Uint8Array(photo.body), {
    headers: { 'Content-Type': photo.type, 'Cache-Control': 'private, max-age=300' },
  });
}
