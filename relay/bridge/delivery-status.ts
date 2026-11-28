// Shared by the bridge and Relay's feedback operator routes.
export const reportFailureStages = ["sanitization", "ticket_creation", "attachment_transfer", "acknowledgement"] as const;
export type ReportFailureStage = typeof reportFailureStages[number];

export function isReportFailureStage(value: unknown): value is ReportFailureStage {
  return reportFailureStages.some((stage) => stage === value);
}
