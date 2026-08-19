/**
 * Ongoing Monitoring & Customer Portfolios Engine (Issue #317).
 *
 * Continuously screens registered customer portfolios against updated
 * sanctions datasets with automatic Decision Memory (#320) suppression
 * and real-time Webhook alert dispatching (#318).
 */

import * as crypto from 'crypto';
import { db } from '../shared/firebase';
import { logger } from '../shared/logger';
import {
  MonitoredSubject,
  MonitoringAlert,
  MonitoringRunSummary,
  AlertStatus,
} from '../shared/types';
import { runSearch } from '../search';
import { saveDecision } from '../decisions';
import { dispatchWebhookEvent } from '../webhooks';

const log = logger.child({ module: 'monitoring' });
const SUBJECTS_COLLECTION = 'monitoredSubjects';
const ALERTS_COLLECTION = 'monitoringAlerts';

export function generateSubjectId(): string {
  return `sub_${crypto.randomBytes(8).toString('hex')}`;
}

export function generateAlertId(): string {
  return `alt_${crypto.randomBytes(8).toString('hex')}`;
}

export interface CreateMonitoredSubjectInput {
  customerId: string;
  name: string;
  type?: 'individual' | 'entity';
  dob?: string;
  country?: string;
  nationality?: string;
  portfolio?: string;
  createdBy: string;
}

export async function registerMonitoredSubject(
  input: CreateMonitoredSubjectInput,
): Promise<MonitoredSubject> {
  if (!input.customerId || !input.customerId.trim()) {
    throw new Error('"customerId" is required.');
  }
  if (!input.name || !input.name.trim()) {
    throw new Error('"name" is required.');
  }

  const id = generateSubjectId();
  const subject: MonitoredSubject = {
    id,
    customerId: input.customerId.trim(),
    name: input.name.trim(),
    type: input.type || 'individual',
    dob: input.dob?.trim() || undefined,
    country: input.country?.trim() || undefined,
    nationality: input.nationality?.trim() || undefined,
    portfolio: input.portfolio?.trim() || 'default',
    status: 'active',
    createdBy: input.createdBy || 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await db.collection(SUBJECTS_COLLECTION).doc(id).set(subject);
  log.info('monitoring.subject_registered', { id, customerId: subject.customerId });
  return subject;
}

export async function batchRegisterMonitoredSubjects(
  subjects: CreateMonitoredSubjectInput[],
): Promise<{ registeredCount: number; errors: { customerId?: string; error: string }[] }> {
  let registeredCount = 0;
  const errors: { customerId?: string; error: string }[] = [];

  for (const item of subjects) {
    try {
      await registerMonitoredSubject(item);
      registeredCount++;
    } catch (err: any) {
      errors.push({ customerId: item.customerId, error: err.message });
    }
  }

  return { registeredCount, errors };
}

export async function listMonitoredSubjects(options?: {
  portfolio?: string;
  status?: string;
}): Promise<MonitoredSubject[]> {
  let query: any = db.collection(SUBJECTS_COLLECTION);
  if (options?.portfolio) {
    query = query.where('portfolio', '==', options.portfolio);
  }
  if (options?.status) {
    query = query.where('status', '==', options.status);
  }

  const snapshot = await query.get();
  const subjects: MonitoredSubject[] = [];
  snapshot.docs.forEach((doc: any) => {
    subjects.push(doc.data() as MonitoredSubject);
  });
  return subjects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteMonitoredSubject(id: string): Promise<boolean> {
  const docRef = db.collection(SUBJECTS_COLLECTION).doc(id);
  const doc = await docRef.get();
  if (!doc.exists) return false;
  await docRef.delete();
  log.info('monitoring.subject_deleted', { id });
  return true;
}

export async function listMonitoringAlerts(options?: {
  status?: AlertStatus;
  customerId?: string;
}): Promise<MonitoringAlert[]> {
  let query: any = db.collection(ALERTS_COLLECTION);
  if (options?.status) {
    query = query.where('status', '==', options.status);
  }
  if (options?.customerId) {
    query = query.where('customerId', '==', options.customerId);
  }

  const snapshot = await query.get();
  const alerts: MonitoringAlert[] = [];
  snapshot.docs.forEach((doc: any) => {
    alerts.push(doc.data() as MonitoringAlert);
  });
  return alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface ResolveAlertInput {
  verdict: 'false_positive' | 'true_positive';
  notes?: string;
  resolvedBy: string;
}

export async function resolveMonitoringAlert(
  alertId: string,
  resolution: ResolveAlertInput,
): Promise<MonitoringAlert> {
  const alertRef = db.collection(ALERTS_COLLECTION).doc(alertId);
  const alertDoc = await alertRef.get();
  if (!alertDoc.exists) {
    throw new Error(`Monitoring alert ${alertId} not found.`);
  }

  const alert = alertDoc.data() as MonitoringAlert;
  const newStatus: AlertStatus =
    resolution.verdict === 'false_positive'
      ? 'dismissed_false_positive'
      : 'confirmed_true_positive';

  // Automatically record decision into Decision Memory (#320)
  await saveDecision({
    entityId: alert.entityId,
    subjectId: alert.customerId,
    verdict: resolution.verdict,
    notes: resolution.notes,
    decidedBy: resolution.resolvedBy,
  });

  const updatedAlert: MonitoringAlert = {
    ...alert,
    status: newStatus,
    notes: resolution.notes,
    resolvedBy: resolution.resolvedBy,
    resolvedAt: new Date().toISOString(),
  };

  await alertRef.set(updatedAlert);
  log.info('monitoring.alert_resolved', { alertId, status: newStatus, decidedBy: resolution.resolvedBy });
  return updatedAlert;
}

/**
 * Runs a continuous monitoring scan across active portfolio subjects.
 * Leverages in-memory search index and Decision Memory to suppress duplicates.
 */
export async function runPortfolioScreening(portfolioId?: string): Promise<MonitoringRunSummary> {
  const startedAt = Date.now();
  const subjects = await listMonitoredSubjects({
    portfolio: portfolioId,
    status: 'active',
  });

  let totalScreened = 0;
  let matchesFound = 0;
  let newAlerts = 0;
  let autoCleared = 0;

  for (const subject of subjects) {
    totalScreened++;
    try {
      const searchRes = await runSearch(subject.name, {
        threshold: 70,
        dob: subject.dob,
        country: subject.country,
        nationality: subject.nationality,
        subjectId: subject.customerId, // Passes customer ID for decision memory lookup
      });

      if (searchRes.results.length > 0) {
        matchesFound += searchRes.results.length;

        for (const hit of searchRes.results) {
          if (hit.autoCleared) {
            autoCleared++;
            continue; // Suppressed by Decision Memory (#320)
          }

          // New or modified match requires alert creation
          const alertId = generateAlertId();
          const alert: MonitoringAlert = {
            id: alertId,
            subjectId: subject.id,
            customerId: subject.customerId,
            subjectName: subject.name,
            entityId: hit.id,
            score: hit.score,
            matchedAlias: hit.matchedAlias,
            source: hit.source,
            status: 'new',
            autoCleared: false,
            createdAt: new Date().toISOString(),
          };

          await db.collection(ALERTS_COLLECTION).doc(alertId).set(alert);
          newAlerts++;

          // Dispatch real-time webhook alert (#318)
          dispatchWebhookEvent('alert.created', {
            alertId,
            customerId: subject.customerId,
            subjectName: subject.name,
            entityId: hit.id,
            score: hit.score,
            matchedAlias: hit.matchedAlias,
            source: hit.source,
            timestamp: alert.createdAt,
          }).catch(() => {});
        }

        // Update last screening metadata on subject
        const highestScore = Math.max(...searchRes.results.map((r) => r.score));
        await db.collection(SUBJECTS_COLLECTION).doc(subject.id).set({
          ...subject,
          lastScreenedAt: new Date().toISOString(),
          lastMatchScore: highestScore,
          updatedAt: new Date().toISOString(),
        });
      } else {
        await db.collection(SUBJECTS_COLLECTION).doc(subject.id).set({
          ...subject,
          lastScreenedAt: new Date().toISOString(),
          lastMatchScore: 0,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      log.error('monitoring.screening_subject_failed', { customerId: subject.customerId, error: err.message });
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary: MonitoringRunSummary = {
    portfolioId,
    totalScreened,
    matchesFound,
    newAlerts,
    autoCleared,
    durationMs,
    completedAt: new Date().toISOString(),
  };

  log.info('monitoring.screening_run_completed', { ...summary });
  return summary;
}
