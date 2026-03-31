import { eq, and, desc } from 'drizzle-orm';
import { getDb } from '../db/client';
import { transcripts as transcriptsTable } from '../db/schema';
import type { Env } from '../types';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export async function saveTranscript(
  env: Env,
  params: {
    customerIdHashed: string;
    businessType: string;
    turns: Turn[];
    callSid?: string;
    emailSentTo?: string;
  }
): Promise<string> {
  const { customerIdHashed, businessType, turns, callSid, emailSentTo } = params;
  const db = getDb(env.DB);
  const now = new Date();

  if (callSid) {
    const existing = await db
      .select()
      .from(transcriptsTable)
      .where(eq(transcriptsTable.callSid, callSid));

    if (existing[0]) {
      await db.update(transcriptsTable)
        .set({
          turns,
          emailSentTo: emailSentTo ?? existing[0].emailSentTo ?? undefined,
          updatedAt: now,
        })
        .where(eq(transcriptsTable.id, existing[0].id));
      return existing[0].id;
    }
  }

  const id = crypto.randomUUID();
  await db.insert(transcriptsTable).values({
    id,
    callSid,
    customerIdHashed,
    businessType,
    emailSentTo,
    turns,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function getTranscripts(
  env: Env,
  customerIdHashed: string,
  businessType: string,
  limit = 10
) {
  const db = getDb(env.DB);
  return db
    .select({
      id: transcriptsTable.id,
      callSid: transcriptsTable.callSid,
      emailSentTo: transcriptsTable.emailSentTo,
      turns: transcriptsTable.turns,
      createdAt: transcriptsTable.createdAt,
    })
    .from(transcriptsTable)
    .where(and(eq(transcriptsTable.customerIdHashed, customerIdHashed), eq(transcriptsTable.businessType, businessType)))
    .orderBy(desc(transcriptsTable.createdAt))
    .limit(limit);
}
