import { NextResponse } from 'next/server';
import { INSTANCE_ID } from '@/server/instance';

// Used by use-session.ts to clear a persisted client session when the backend process has changed.
export async function GET() {
  return NextResponse.json({ instanceId: INSTANCE_ID });
}
