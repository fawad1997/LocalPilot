// tracker-utils.mjs — Load, save, update application tracker

import { readFile, writeFile, rename } from 'fs/promises';

export async function loadTracker(filePath) {
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {
      metadata: {
        lastEmailCheck: null, lastN8nSync: null, totalApplications: 0,
        stats: { applied: 0, interview: 0, rejected: 0, noResponse: 0, notApplied: 0 }
      },
      applications: [],
      insights: { lastAnalysis: null, interviewRate: 0, patterns: [] }
    };
  }
}

export async function saveTracker(filePath, tracker) {
  tracker.metadata.totalApplications = tracker.applications.length;
  tracker.metadata.stats = recomputeStats(tracker.applications);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(tracker, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

export function updateApplicationStatus(app, status, source, emailId, emailSubject) {
  if (emailId && app.statusHistory.some(h => h.emailId === emailId)) return false;
  const entry = { status, date: new Date().toISOString().split('T')[0], source };
  if (emailId) entry.emailId = emailId;
  if (emailSubject) entry.emailSubject = emailSubject;
  app.statusHistory.push(entry);
  if (status !== 'confirmation') app.status = status;
  return true;
}

export function recomputeStats(applications) {
  const stats = { applied: 0, interview: 0, rejected: 0, noResponse: 0, notApplied: 0 };
  for (const app of applications) {
    if (stats[app.status] !== undefined) stats[app.status]++;
  }
  return stats;
}

export function isEmailProcessed(tracker, emailId) {
  if (!emailId) return false;
  return tracker.applications.some(app =>
    app.statusHistory.some(h => h.emailId === emailId)
  );
}
