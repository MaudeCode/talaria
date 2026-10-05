/** Resource shapes live in the contract package; re-exported for the existing import paths. */
export {
  AuthStatusSchema, LoginResponseSchema, SettingsSchema, ProfileSchema, ReasoningStatusSchema, ProfilesSchema, ActiveProfileSchema, ModelEntrySchema, ModelGroupSchema, ModelsSchema, ProviderSchema, ProvidersSchema,
  QuotaSourceSchema as ProviderQuotaSourceSchema, ProviderQuotasSchema, ProviderCostHistorySchema, PersonalitiesSchema, AuxiliaryModelsSchema, WorkspaceEntrySchema as WorkspaceSchema, WorkspacesSchema, FileEntrySchema, DirListingSchema, FileContentSchema, GitInfoSchema,
  SkillSchema, SkillsSchema, SkillContentSchema, SkillsUsageSchema, MemorySchema, CronScheduleSchema, CronRepeatSchema, CronJobViewSchema as CronJobSchema, CronsSchema, CronMutationSchema, CronRunUsageSchema, CronRunSummarySchema,
  CronHistorySchema, CronRunSchema, CronStatusSchema, PromptSchema, PromptsSchema, CommandRowSchema as CommandSchema, CommandsSchema, OnboardingProviderSchema, OnboardingStatusSchema, OnboardingProbeSchema, OnboardingOAuthSchema,
  ExtensionStatusSchema, DashboardStatusSchema, AgentHealthSchema, SystemHealthSchema, UpdateTargetSchema, UpdatesCheckSchema, UpdatesSummarySchema, UpdateApplySchema, UpdateNotificationSchema, UpdateNotificationsSchema, LogsSchema, InsightsSchema,
  KanbanTaskViewSchema as KanbanTaskSchema, KanbanColumnSchema, KanbanBoardViewSchema as KanbanBoardSchema, KanbanBoardsViewSchema as KanbanBoardsSchema, PluginSchema, PluginsSchema, McpServersSchema, NotesSourcesSchema, TodoItemSchema, TodoStateSchema,
  type AuthStatus, type Settings, type ReasoningStatus, type Profiles, type Models, type Workspace, type Workspaces, type Memory, type CronJob, type Crons, type CronHistory, type Command, type OnboardingStatus, type UpdateNotification, type UpdateNotifications, type Logs, type Insights, type TodoState, type QuotaThresholds, type QuotaLevel,
} from '@maudecode/talaria-web-contracts'
