import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, SlidersHorizontal, Square } from 'lucide-react'
import { GROUP_ROOM_NAME_LIMIT, type GroupCatalog, type GroupOperation, type GroupRoom } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { openGroupStream } from '../../api/sse'
import { useSettingsQuery } from '../../app/queries'
import { useBootstrap } from '../../app/bootstrap'
import { HubPage, MAIN_VIEW } from '../../shell/AppShell'
import { PanelHead, PanelHeadButton } from '../../shell/PanelHead'
import { BackButton, Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { Transcript } from '../chat/Transcript'
import { RunElapsed } from '../chat/LiveTurnView'
import { ApprovalCard } from '../chat/ApprovalCard'
import { usePromptAnswer } from '../chat/usePromptAnswer'
import { Composer } from '../composer/Composer'
import type { PendingFile } from '../composer/Attachments'
import { ComposerNotices } from '../composer/ComposerNotices'
import { showErrorToast } from '../toast/errorToast'
import { isDefiniteRefusal } from '../../contracts/common'
import { randomUuid } from '../../lib/randomHex'
import { m } from '../../paraglide/messages.js'

type RoomContext = NonNullable<GroupRoom['context']>
const sameContext = (left: RoomContext | null | undefined, right: RoomContext) => left?.purpose === right.purpose && left.notes === right.notes && left.routing === right.routing && left.lead_member_id === right.lead_member_id

const phaseLabel: Record<GroupRoom['members'][number]['phase'], () => string> = {
  idle: () => m.group_idle(), queued: () => m.group_queued(), running: () => m.group_running(), stopping: () => m.group_stopping(),
  unknown: () => m.group_unknown_phase(), failed: () => m.group_failed(), approval: () => m.group_approval(),
}

/** Rooms share the chat presentation but never its prompt-admission or single-turn state. */
export function GroupsPage({ roomId }: { roomId: string | undefined }) {
  const navigate = useNavigate(), qc = useQueryClient(), bootstrap = useBootstrap()
  const [offset, setOffset] = useState(0)
  const catalogKey = ['groups', bootstrap.profile?.name, 'catalog', offset]
  const catalog = useQuery({ queryKey: catalogKey, queryFn: () => api.fetchGroups(offset) })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [provisional, setProvisional] = useState<{ id: string; name: string } | null>(null)
  const navigation = useRef(0)
  useEffect(() => () => { navigation.current += 1 }, [])
  const leaveFor = (id?: string) => {
    navigation.current += 1
    setProvisional((current) => current?.id === id ? current : null)
  }
  const select = (id?: string) => {
    leaveFor(id)
    void navigate({ to: '/groups', search: id ? { room: id } : {} })
  }
  const create = () => {
    const id = randomUuid(), title = name.trim()
    setCreating(false); setProvisional({ id, name: title }); select(id)
    const revision = navigation.current
    void api.writeGroup(catalog.data?.identity ?? null, { action: 'create', room_id: id, name: title, members: members.map((profile, i) => ({ member_id: `member-${i}`, handle: `member-${i}`, profile })) }).then((result) => {
      void qc.invalidateQueries({ queryKey: ['groups'] })
      if (navigation.current !== revision) return
      setProvisional(null)
      if (result.outcome === 'refused') { setProvisional(null); select(); showErrorToast(new Error(m.group_write_refused())) }
      else if (result.outcome === 'unknown') showErrorToast(new Error(m.group_unknown()))
    }, (error: unknown) => { if (navigation.current === revision) { setProvisional(null); if (isDefiniteRefusal(error)) select(); showErrorToast(error) } })
  }
  return <>
    {roomId ? <Discussion key={`${bootstrap.profile?.name}:${roomId}`} roomId={roomId} provisionalName={provisional?.id === roomId ? provisional.name : undefined} onBack={() => select()} onDisband={() => {
      qc.setQueryData<GroupCatalog>(catalogKey, (current) => current ? { ...current, rooms: current.rooms.filter((room) => room.id !== roomId) } : current)
      select()
      const revision = navigation.current
      return () => { if (navigation.current === revision) { select(roomId); void catalog.refetch() } }
    }} />
      : <HubPage title={m.group_discussions()} actions={<Button variant="primary" disabled={!catalog.data?.actions.includes('create')} onClick={() => setCreating(true)}><Plus size={12} aria-hidden="true" /> {m.group_create()}</Button>}>
        {catalog.data && !catalog.data.available && <p role="status" className="mb-4 text-xs text-muted">{m.group_unavailable()}</p>}
        {catalog.isPending && <LoadingState />}
        {catalog.isError && <ErrorState error={catalog.error} onRetry={() => { void catalog.refetch() }} />}
        {catalog.data?.available && catalog.data.rooms.length === 0 && <EmptyState>{m.group_no_discussions()}</EmptyState>}
        <section data-section="groups">
          <ul className="flex flex-col">{catalog.data?.rooms.map((room) => <li key={room.id} data-group-room={room.id} className="border-t border-border first:border-t-0"><Link to="/groups" search={{ room: room.id }} onClick={() => leaveFor(room.id)} className="block truncate py-4 text-sm font-semibold text-text hover:bg-hover">{room.name}</Link></li>)}</ul>
          {(offset > 0 || catalog.data?.next_offset != null) && <div className="mt-4 flex gap-2">{offset > 0 && <Button onClick={() => setOffset(0)}>{m.group_first_page()}</Button>}{catalog.data?.next_offset != null && <Button onClick={() => setOffset(catalog.data?.next_offset ?? 0)}>{m.group_next_page()}</Button>}</div>}
        </section>
      </HubPage>}
    <Dialog open={creating} onOpenChange={setCreating} title={m.group_create()}>
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); create() }}>
        <label className="flex flex-col gap-1 text-sm">{m.group_name()}<TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={GROUP_ROOM_NAME_LIMIT} /></label>
        <fieldset><legend className="mb-2 text-sm">{m.group_members()}</legend>{catalog.data?.profiles.map((profile) => <label key={profile.profile} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={members.includes(profile.profile)} onChange={(e) => setMembers((current) => e.target.checked ? [...current, profile.profile] : current.filter((p) => p !== profile.profile))} />{profile.label}</label>)}</fieldset>
        <Button type="submit" disabled={!name.trim() || members.length < 2 || members.length > 6}>{m.group_create()}</Button>
      </form>
    </Dialog>
  </>
}

function Discussion({ roomId, provisionalName, onBack, onDisband }: { roomId: string; provisionalName: string | undefined; onBack: () => void; onDisband: () => () => void }) {
  const focus = useRef<HTMLDivElement>(null)
  const qc = useQueryClient(), settings = useSettingsQuery(), bootstrap = useBootstrap()
  const [before, setBefore] = useState<number | undefined>()
  const key = ['groups', bootstrap.profile?.name, roomId, before]
  const view = useQuery({ queryKey: key, queryFn: ({ signal }) => api.fetchGroup(roomId, before, signal), enabled: provisionalName === undefined })
  const [intent, setIntent] = useState<{ identity: string; text: string; id: string; eventId: string | null; unknown: boolean; files: PendingFile[] } | null>(null)
  const [renameDraft, setRenameDraft] = useState<{ identity: string; value: string } | null>(null)
  const [renameIntent, setRenameIntent] = useState<{ identity: string; value: string; id: string; revision: number; unknown: boolean } | null>(null)
  const [contextDraft, setContextDraft] = useState<{ identity: string; value: RoomContext } | null>(null)
  const [contextIntent, setContextIntent] = useState<{ identity: string; id: string; value: RoomContext; unknown: boolean } | null>(null)
  const [composerRoom, setComposerRoom] = useState<GroupRoom | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  useEffect(() => {
    if (before !== undefined || provisionalName !== undefined) return
    let active = true
    const stream = openGroupStream(roomId, (next) => {
      const queryKey = ['groups', bootstrap.profile?.name, roomId, before]
      void qc.cancelQueries({ queryKey, exact: true }).then(() => { if (active) qc.setQueryData(queryKey, next) })
    })
    return () => { active = false; stream.close() }
  }, [roomId, before, qc, bootstrap.profile?.name, provisionalName])
  const data = view.data, room = data?.room, roomContext = room?.context
  // Keep draft/file custody through a read gap; current server fields still authorize every write.
  if (room && room !== composerRoom) setComposerRoom(room)
  const retainedRoom = room ?? composerRoom
  const committedIntent = intent?.identity === room?.identity && intent?.eventId !== null && data?.rows.some((row) => row.message.message_id === intent?.eventId)
  const currentIntent = intent?.identity === room?.identity && !committedIntent ? intent : null
  if (committedIntent) setIntent(null)
  const settledRename = room && renameIntent?.identity === room.identity && (room.name === renameIntent.value || room.revision > renameIntent.revision)
  const currentRename = renameIntent?.identity === room?.identity && !settledRename ? renameIntent : null
  if (settledRename) setRenameIntent(null)
  const currentDraft = renameDraft?.identity === room?.identity ? renameDraft : null
  const settledContext = room && contextIntent?.identity === room.identity && sameContext(room.context, contextIntent.value)
  const currentContext = contextIntent?.identity === room?.identity && !settledContext ? contextIntent : null
  if (settledContext) setContextIntent(null)
  const currentContextDraft = contextDraft?.identity === room?.identity ? contextDraft : null
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups', bootstrap.profile?.name, roomId] })
  const write = async (operation: GroupOperation) => {
    const result = await api.writeGroup(room?.identity ?? null, operation)
    await refresh()
    if (result.outcome !== 'confirmed') throw new Error(result.outcome === 'unknown' ? m.group_unknown() : m.group_write_refused(), { cause: result.outcome })
    return result
  }
  const send = async (text: string, files: PendingFile[]) => {
    const id = randomUuid(), identity = room?.identity ?? ''
    setIntent({ identity, text, id, eventId: null, unknown: false, files })
    const clear = () => setIntent((current) => current?.id === id ? null : current)
    const refuse = (error: unknown) => { clear(); showErrorToast(error); return false }
    const reconcile = async () => {
      const [next, receipt] = await Promise.all([api.fetchGroup(roomId), api.fetchGroupReceipt(roomId, id)])
      if (next.room?.identity === identity) qc.setQueryData(key, next)
      return next.room?.identity === identity && receipt.outcome === 'confirmed'
    }
    let eventId: string
    try { eventId = (await api.fetchGroupSendIdentity(id)).event_id }
    catch (error) { return refuse(error) } // No write has been attempted.
    setIntent((current) => current?.id === id ? { ...current, eventId } : current)
    try {
      const result = await api.writeGroup(room?.identity ?? null, { action: 'send', room_id: roomId, event_id: id, payload: { text, attachments: files.flatMap((f) => f.groupAttachment ? [f.groupAttachment] : []) } })
      if (result.outcome === 'refused') return refuse(new Error(m.group_write_refused()))
      if (result.outcome === 'confirmed') { void refresh().then(clear, clear); return true }
      if (await reconcile()) { clear(); return true }
    } catch (error) {
      if (isDefiniteRefusal(error)) return refuse(error)
      if (await reconcile().catch(() => false)) { clear(); return true }
    }
    setIntent((current) => current?.id === id ? { ...current, unknown: true } : current)
    return true
  }
  const renameRoom = () => {
    if (!currentDraft || !room) return
    const id = randomUuid(), identity = room.identity, value = currentDraft.value
    setRenameDraft(null)
    setRenameIntent({ id, identity, value, revision: room.revision, unknown: false })
    void write({ action: 'rename', room_id: roomId, event_id: id, name: value }).then(() => {
      setRenameIntent((current) => current?.id === id ? null : current)
    }, (error: unknown) => {
      setRenameIntent((current) => {
        if (current?.id !== id) return current
        return error instanceof Error && error.cause === 'unknown' ? { ...current, unknown: true } : null
      })
      showErrorToast(error)
    })
  }
  /** Optimistic with rollback: a refusal reopens the draft; an unknown outcome keeps it shown until Retry resends this same event id. */
  const saveContext = (identity: string, id: string, value: RoomContext) => {
    const settle = (next: typeof contextIntent) => setContextIntent((current) => current?.id === id ? next : current)
    setContextDraft(null)
    setContextIntent({ identity, id, value, unknown: false })
    void write({ action: 'context', room_id: roomId, event_id: id, purpose: value.purpose, notes: value.notes, routing: value.routing, ...(value.routing === 'lead' ? { lead_member_id: value.lead_member_id } : {}) }).then(() => settle(null), (error: unknown) => {
      if ((error instanceof Error && error.cause === 'unknown') || !isDefiniteRefusal(error)) { settle({ identity, id, value, unknown: true }); void refresh(); return }
      settle(null)
      setContextDraft({ identity, value })
      showErrorToast(error)
    })
  }
  const retryContext = (pending: NonNullable<typeof currentContext>) => {
    void api.fetchGroup(roomId).then((next) => {
      void refresh()
      if (next.room?.identity === pending.identity && !sameContext(next.room.context, pending.value)) saveContext(pending.identity, pending.id, pending.value)
    }).catch(showErrorToast)
  }
  const isLead = (member: GroupRoom['members'][number]) => currentContext ? currentContext.value.routing === 'lead' && currentContext.value.lead_member_id === member.member_id : member.lead
  const phase = (member: GroupRoom['members'][number]) => stopping === room?.identity && member.phase !== 'idle' ? m.group_stopping() : member.stalled ? m.group_stalled() : phaseLabel[member.phase]()
  return <div ref={focus} tabIndex={-1} className={`${MAIN_VIEW} active`}>
    <PanelHead title={currentRename?.value ?? room?.name ?? provisionalName ?? m.group_discussions()} actions={<>
      <BackButton onClick={onBack} />
      {before !== undefined && <Button onClick={() => setBefore(undefined)}>{m.group_latest()}</Button>}
      {room?.actions.includes('rename') && <Button onClick={() => setRenameDraft({ identity: room.identity, value: currentRename?.value ?? room.name })}>{m.rename()}</Button>}
      {roomContext && room?.actions.includes('context') && <PanelHeadButton label={m.group_settings()} onClick={() => setContextDraft({ identity: room.identity, value: currentContext?.value ?? roomContext })}><SlidersHorizontal size={14} aria-hidden="true" /></PanelHeadButton>}
      {room?.actions.includes('disband') && <Button onClick={() => { const rollback = onDisband(); void write({ action: 'disband', room_id: roomId, cancel_id: randomUuid() }).then(() => qc.invalidateQueries({ queryKey: ['groups'] }), (error: unknown) => { rollback(); showErrorToast(error) }) }}>{m.group_disband()}</Button>}
      {room?.actions.includes('stop') && <PanelHeadButton label={m.composer_stop()} disabled={stopping === room.identity} onClick={() => { const identity = room.identity; setStopping(identity); void write({ action: 'stop', room_id: roomId, cancel_id: randomUuid() }).catch(showErrorToast).finally(() => setStopping((current) => current === identity ? null : current)) }}><Square size={14} aria-hidden="true" /></PanelHeadButton>}
    </>} />
    {room && <ul aria-label={m.group_members()} className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-2 text-xs text-muted">{room.members.map((member) => <li key={member.member_id} title={`${member.display_name || member.profile} · ${phase(member)}${member.tool ? ` · ${member.tool}` : ''}`} className={`max-w-full truncate ${member.stalled ? 'text-warning' : ''}`}>{member.display_name || member.profile}{isLead(member) && ` · ${m.group_lead()}`} · <span role="status">{member.stalled || !member.tool || stopping === room.identity ? phase(member) : null}{member.tool && <>{member.stalled || stopping === room.identity ? ' · ' : ''}{member.tool}</>}{member.started_at != null && <> · <RunElapsed since={member.started_at * 1000} showSeconds /></>}</span></li>)}</ul>}
    {room?.round && <p role="status" className="px-4 pb-2 text-xs text-muted">{m.group_round({ current: room.round.current, max: room.round.max })}</p>}
    {view.isPending && <LoadingState />}
    {view.isError && <ErrorState error={view.error} onRetry={() => { void view.refetch() }} />}
    {data && !data.available && <p role="status" className="p-4 text-sm text-muted">{m.group_unavailable()}</p>}
    {room?.disbanded && <p role="status" className="p-4 text-sm text-muted">{m.group_disbanded()}</p>}
    <Transcript rows={data?.rows ?? []} live={null} assistantName="" mode="transparent_stream" renderUserMarkdown={false} autoFollow sessionId={undefined} actions={{}} tts={false}
      truncated={data?.has_more ?? false} loadedFrom={data?.rows[0]?.index ?? 0} onLoadOlder={() => { if (data?.next_before_seq) setBefore(data.next_before_seq) }} loadingOlder={view.isFetching} emptyState={null}
      pendingUserText={currentIntent?.text} pendingAttachments={currentIntent?.files.flatMap((file) => file.groupAttachment ? [{ name: file.groupAttachment.name, mime: file.groupAttachment.mime, size: file.groupAttachment.size, is_image: file.groupAttachment.kind === 'image' }] : [])} showJumpButtons={false} virtualizeLongTranscripts={false} disclosureScope={room?.identity} />
    <div className="px-3">
      {room?.members.flatMap((member) => member.actions.map((action) => action.kind === 'approval' && action.request_id ? <ApprovalCard key={`${room.identity}:${action.task_id}:${action.request_id}`} sessionId={`group:${room.identity}:${member.member_id}`} pending={{ approval_id: action.request_id, command: action.approval?.command, description: action.approval?.description, title: member.display_name || member.profile, allowed_choices: action.approval?.choices ?? ['once', 'deny'], can_enable_yolo: false }} onResolved={() => { void refresh() }} transport={{
        send: async (choice) => { if (choice !== 'once' && choice !== 'deny') throw new Error(m.group_write_refused()); return write({ action: 'approve', room_id: roomId, member_id: member.member_id, task_id: action.task_id, execution_generation: action.execution_generation, request_id: action.request_id ?? '', choice }) },
        waiting: () => groupActionWaiting(room, action),
      }} /> : action.kind !== 'approval' ? <GroupRecoveryAction key={`${room.identity}:${action.task_id}:${action.kind}`} room={room} label={`${member.display_name || member.profile} · ${phaseLabel[member.phase]()}`} action={{ ...action, kind: action.kind }} focus={focus} onControl={write} onResolved={() => { void refresh() }} /> : null))}
      {room?.retry_task && <GroupRecoveryAction key={`${room.identity}:${room.retry_task.task_id}:retry`} room={room} label={`${room.name} · ${m.group_failed()}`} action={{ kind: 'retry', ...room.retry_task }} focus={focus} onControl={write} onResolved={() => { void refresh() }} />}
      {currentIntent?.unknown && <ComposerNotices fallbackFocus={focus} notices={[{ id: 'unknown', tone: 'error', content: m.group_unknown(), action: { label: m.refresh(), run: () => { const id = currentIntent.id; void api.fetchGroupReceipt(roomId, id).then((receipt) => { void refresh(); if (receipt.outcome === 'confirmed') setIntent((current) => current?.id === id ? null : current) }).catch(showErrorToast) } } }]} />}
      {currentRename?.unknown && <ComposerNotices fallbackFocus={focus} notices={[{ id: 'rename-unknown', tone: 'error', content: m.group_unknown(), action: { label: m.refresh(), run: () => { const pending = currentRename; void api.fetchGroup(roomId).then((next) => { if (next.room?.identity !== pending.identity) return; qc.setQueryData(key, next) }).catch(showErrorToast) } } }]} />}
      {currentContext?.unknown && <ComposerNotices fallbackFocus={focus} notices={[{ id: 'context-unknown', tone: 'error', content: m.group_context_unknown(), action: { label: m.retry(), run: () => retryContext(currentContext) } }]} />}
    </div>
    {retainedRoom && !retainedRoom.disbanded && <Composer key={retainedRoom.identity} settings={settings.data} room={{ identity: retainedRoom.identity, maxUploadBytes: retainedRoom.max_upload_bytes, maxAttachments: retainedRoom.attachment_limit, canSend: !!data?.available && !view.isError && !!room?.actions.includes('send') && !currentIntent && before === undefined,
      onSend: send, onUpload: async (file) => { if (!data?.available || view.isError || !room) throw new Error(m.group_unavailable()); const result = await api.uploadGroupFile(roomId, room.identity, file); if (!result.attachment || result.outcome !== 'confirmed') throw new Error(m.group_write_refused()); return result.attachment } }} />}
    <Dialog open={currentDraft !== null} onOpenChange={(open) => { if (!open) setRenameDraft(null) }} title={m.rename()}><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); renameRoom() }}><TextInput value={currentDraft?.value ?? ''} aria-label={m.group_name()} onChange={(e) => setRenameDraft((current) => current ? { ...current, value: e.target.value } : current)} required maxLength={GROUP_ROOM_NAME_LIMIT} /><Button type="submit">{m.save()}</Button></form></Dialog>
    {room && <GroupSettingsDialog room={room} value={currentContextDraft?.value ?? null} onChange={(value) => setContextDraft({ identity: room.identity, value })} onClose={() => setContextDraft(null)} onSave={(value) => saveContext(room.identity, randomUuid(), value)} />}
  </div>
}

function GroupSettingsDialog({ room, value, onChange, onClose, onSave }: { room: GroupRoom; value: RoomContext | null; onChange: (value: RoomContext) => void; onClose: () => void; onSave: (value: RoomContext) => void }) {
  const notesOverLimit = !!value && new TextEncoder().encode(value.notes.trim()).length > room.notes_limit_bytes
  const route = (routing: RoomContext['routing'], lead_member_id: string, label: string) => value && <label key={lead_member_id} className="flex min-h-11 items-center gap-2 text-sm"><input type="radio" name="group-routing" checked={value.routing === routing && value.lead_member_id === lead_member_id} onChange={() => onChange({ ...value, routing, lead_member_id })} />{label}</label>
  return <Dialog open={value !== null} onOpenChange={(open) => { if (!open) onClose() }} title={m.group_settings()} className="max-h-[90dvh] overflow-y-auto">
    {value && <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!notesOverLimit) onSave(value) }}>
      <label className="flex flex-col gap-1 text-sm">{m.group_purpose()}<TextInput value={value.purpose} onChange={(e) => onChange({ ...value, purpose: e.target.value })} maxLength={room.purpose_limit} /></label>
      <label className="flex flex-col gap-1 text-sm">{m.group_notes()}<textarea value={value.notes} rows={5} aria-invalid={notesOverLimit} onChange={(e) => onChange({ ...value, notes: e.target.value })} className="min-h-9 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-text focus:border-accent" /></label>
      {notesOverLimit && <p role="alert" className="text-xs text-danger">{m.group_notes_too_long({ n: room.notes_limit_bytes })}</p>}
      <fieldset><legend className="mb-2 text-sm">{m.group_routing()}</legend>
        {route('everyone', '', m.group_routing_everyone())}
        {room.members.map((member) => route('lead', member.member_id, m.group_routing_lead({ name: member.display_name || member.profile })))}
      </fieldset>
      <div className="sticky -bottom-5 -mb-5 bg-surface pb-5 pt-2"><Button type="submit" disabled={notesOverLimit}>{m.save()}</Button></div>
    </form>}
  </Dialog>
}

type GroupTask = NonNullable<GroupRoom['retry_task']> & { kind: GroupRoom['members'][number]['actions'][number]['kind']; request_id?: string | undefined }

/** Native Retry/Discard, a member's or the room's own, use the shared optimistic prompt-answer and status-chip owners. */
function GroupRecoveryAction({ room, label, action, focus, onControl, onResolved }: {
  room: GroupRoom; label: string; action: GroupTask & { kind: 'retry' | 'discard' };
  focus: RefObject<HTMLElement | null>; onControl: (operation: GroupOperation) => Promise<unknown>; onResolved: () => void
}) {
  const resource = `group:${room.identity}:${action.member_id}:${action.task_id}:${action.execution_generation}:${action.kind}`
  const { answer, answered } = usePromptAnswer({
    resource: () => resource, queryKey: ['groups'],
    send: () => onControl({ action: action.kind, room_id: room.id, member_id: action.member_id, task_id: action.task_id, execution_generation: action.execution_generation }),
    waiting: () => groupActionWaiting(room, action),
    onAnswered: onResolved,
  })
  if (answered(resource)) return null
  return <ComposerNotices fallbackFocus={focus} notices={[{ id: resource, content: <span>{label}</span>, action: { label: action.kind === 'retry' ? m.retry() : m.discard(), run: () => answer(undefined) } }]} />
}

async function groupActionWaiting(room: GroupRoom, action: GroupTask): Promise<boolean> {
  const next = (await api.fetchGroup(room.id)).room
  if (!next) return true
  const roomTask = action.kind === 'retry' && next.retry_task?.task_id === action.task_id && next.retry_task.execution_generation === action.execution_generation
  return next.identity === room.identity && (roomTask || next.members.some((member) => member.member_id === action.member_id && member.actions.some((current) => current.kind === action.kind && current.task_id === action.task_id && current.execution_generation === action.execution_generation && current.request_id === action.request_id)))
}
