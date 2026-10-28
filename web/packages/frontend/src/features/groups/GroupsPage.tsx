import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Square } from 'lucide-react'
import { GROUP_ROOM_NAME_LIMIT, type GroupCatalog, type GroupOperation, type GroupRoom } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { openGroupStream } from '../../api/sse'
import { useSettingsQuery } from '../../app/queries'
import { useBootstrap } from '../../app/bootstrap'
import { AppShell, MAIN_VIEW } from '../../shell/AppShell'
import { PanelHead, PanelHeadButton } from '../../shell/Sidebar'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { TextInput } from '../../ui/Field'
import { ErrorState, LoadingState } from '../../ui/States'
import { Transcript } from '../chat/Transcript'
import { ApprovalCard } from '../chat/ApprovalCard'
import { usePromptAnswer } from '../chat/usePromptAnswer'
import { Composer } from '../composer/Composer'
import type { PendingFile } from '../composer/Attachments'
import { ComposerNotices } from '../composer/ComposerNotices'
import { showErrorToast } from '../toast/errorToast'
import { isDefiniteRefusal } from '../../contracts/common'
import { m } from '../../paraglide/messages.js'

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
  const select = (id?: string) => {
    navigation.current += 1
    setProvisional((current) => current?.id === id ? current : null)
    void navigate({ to: '/groups', search: id ? { room: id } : {} })
  }
  const create = () => {
    const id = crypto.randomUUID(), title = name.trim()
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
  return <AppShell sidebar={<div className="panel-view active flex min-h-0 flex-col">
    <PanelHead title={m.group_discussions()} actions={<PanelHeadButton label={m.group_create()} disabled={!catalog.data?.actions.includes('create')} onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" /></PanelHeadButton>} />
    <Link to="/" className="px-3 py-3 text-sm text-muted">{m.tab_chat()}</Link>
    {catalog.isPending && <LoadingState />}
    {catalog.isError && <ErrorState error={catalog.error} onRetry={() => { void catalog.refetch() }} />}
    <ul className="flex min-h-0 flex-col overflow-y-auto px-2">{catalog.data?.rooms.map((room) => <li key={room.id}><Button variant="ghost" className="w-full justify-start" aria-current={room.id === roomId ? 'page' : undefined} onClick={() => select(room.id)}>{room.name}</Button></li>)}</ul>
    <div className="flex gap-2 p-2">{offset > 0 && <Button onClick={() => setOffset(0)}>{m.group_first_page()}</Button>}{catalog.data?.next_offset != null && <Button onClick={() => setOffset(catalog.data?.next_offset ?? 0)}>{m.group_next_page()}</Button>}</div>
    {catalog.data && !catalog.data.available && <p role="status" className="p-3 text-sm text-muted">{m.group_unavailable()}</p>}
  </div>}>
    {roomId ? <Discussion key={`${bootstrap.profile?.name}:${roomId}`} roomId={roomId} provisionalName={provisional?.id === roomId ? provisional.name : undefined} onDisband={() => {
      qc.setQueryData<GroupCatalog>(catalogKey, (current) => current ? { ...current, rooms: current.rooms.filter((room) => room.id !== roomId) } : current)
      select()
      const revision = navigation.current
      return () => { if (navigation.current === revision) { select(roomId); void catalog.refetch() } }
    }} />
      : <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6"><h1 className="text-xl font-semibold">{m.group_discussions()}</h1><Button disabled={!catalog.data?.actions.includes('create')} onClick={() => setCreating(true)}>{m.group_create()}</Button></div>}
    <Dialog open={creating} onOpenChange={setCreating} title={m.group_create()}>
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); create() }}>
        <label className="flex flex-col gap-1 text-sm">{m.group_name()}<TextInput value={name} onChange={(e) => setName(e.target.value)} required maxLength={GROUP_ROOM_NAME_LIMIT} /></label>
        <fieldset><legend className="mb-2 text-sm">{m.group_members()}</legend>{catalog.data?.profiles.map((profile) => <label key={profile.profile} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={members.includes(profile.profile)} onChange={(e) => setMembers((current) => e.target.checked ? [...current, profile.profile] : current.filter((p) => p !== profile.profile))} />{profile.label}</label>)}</fieldset>
        <Button type="submit" disabled={!name.trim() || members.length < 2 || members.length > 6}>{m.group_create()}</Button>
      </form>
    </Dialog>
  </AppShell>
}

function Discussion({ roomId, provisionalName, onDisband }: { roomId: string; provisionalName: string | undefined; onDisband: () => () => void }) {
  const focus = useRef<HTMLDivElement>(null)
  const qc = useQueryClient(), settings = useSettingsQuery(), bootstrap = useBootstrap()
  const [before, setBefore] = useState<number | undefined>()
  const key = ['groups', bootstrap.profile?.name, roomId, before]
  const view = useQuery({ queryKey: key, queryFn: ({ signal }) => api.fetchGroup(roomId, before, signal), enabled: provisionalName === undefined })
  const [intent, setIntent] = useState<{ identity: string; text: string; id: string; unknown: boolean; files: PendingFile[] } | null>(null)
  const [renameDraft, setRenameDraft] = useState<{ identity: string; value: string } | null>(null)
  const [renameIntent, setRenameIntent] = useState<{ identity: string; value: string; id: string; unknown: boolean } | null>(null)
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
  const data = view.data, room = data?.room
  const currentIntent = intent?.identity === room?.identity ? intent : null
  const currentRename = renameIntent?.identity === room?.identity ? renameIntent : null
  const currentDraft = renameDraft?.identity === room?.identity ? renameDraft : null
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups', bootstrap.profile?.name, roomId] })
  const write = async (operation: GroupOperation) => {
    const result = await api.writeGroup(room?.identity ?? null, operation)
    await refresh()
    if (result.outcome !== 'confirmed') throw new Error(result.outcome === 'unknown' ? m.group_unknown() : m.group_write_refused(), { cause: result.outcome })
    return result
  }
  const send = async (text: string, files: PendingFile[]) => {
    const id = crypto.randomUUID(), identity = room?.identity ?? ''
    setIntent({ identity, text, id, unknown: false, files })
    const clear = () => setIntent((current) => current?.id === id ? null : current)
    const reconcile = async () => {
      const [next, receipt] = await Promise.all([api.fetchGroup(roomId), api.fetchGroupReceipt(roomId, id)])
      if (next.room?.identity === identity) qc.setQueryData(key, next)
      return next.room?.identity === identity && receipt.outcome === 'confirmed'
    }
    try {
      const result = await api.writeGroup(room?.identity ?? null, { action: 'send', room_id: roomId, event_id: id, payload: { text, attachments: files.flatMap((f) => f.groupAttachment ? [f.groupAttachment] : []) } })
      if (result.outcome === 'confirmed' || await reconcile()) { await refresh(); clear(); return true }
      if (result.outcome === 'refused') { clear(); showErrorToast(new Error(m.group_write_refused())); return false }
    } catch { if (await reconcile().catch(() => false)) { clear(); return true } }
    setIntent((current) => current?.id === id ? { ...current, unknown: true } : current)
    return true
  }
  const renameRoom = () => {
    if (!currentDraft || !room) return
    const id = crypto.randomUUID(), identity = room.identity, value = currentDraft.value
    setRenameDraft(null)
    setRenameIntent({ id, identity, value, unknown: false })
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
  const phase = (member: GroupRoom['members'][number]) => stopping === room?.identity && member.phase !== 'idle' ? m.group_stopping() : phaseLabel[member.phase]()
  return <div ref={focus} tabIndex={-1} className={`${MAIN_VIEW} active`}>
    <PanelHead title={currentRename?.value ?? room?.name ?? provisionalName ?? m.group_discussions()} actions={<>
      {before !== undefined && <Button onClick={() => setBefore(undefined)}>{m.group_latest()}</Button>}
      {room?.actions.includes('rename') && <Button onClick={() => setRenameDraft({ identity: room.identity, value: currentRename?.value ?? room.name })}>{m.rename()}</Button>}
      {room?.actions.includes('disband') && <Button onClick={() => { const rollback = onDisband(); void write({ action: 'disband', room_id: roomId, cancel_id: crypto.randomUUID() }).then(() => qc.invalidateQueries({ queryKey: ['groups'] }), (error: unknown) => { rollback(); showErrorToast(error) }) }}>{m.group_disband()}</Button>}
      {room?.actions.includes('stop') && <PanelHeadButton label={m.composer_stop()} disabled={stopping === room.identity} onClick={() => { const identity = room.identity; setStopping(identity); void write({ action: 'stop', room_id: roomId, cancel_id: crypto.randomUUID() }).catch(showErrorToast).finally(() => setStopping((current) => current === identity ? null : current)) }}><Square size={14} aria-hidden="true" /></PanelHeadButton>}
    </>} />
    {room && <ul aria-label={m.group_members()} className="flex flex-wrap gap-x-5 gap-y-2 px-4 py-2 text-xs text-muted">{room.members.map((member) => <li key={member.member_id}>{member.display_name || member.profile} · <span role="status">{phase(member)}</span></li>)}</ul>}
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
      }} /> : action.kind !== 'approval' ? <GroupRecoveryAction key={`${room.identity}:${action.task_id}:${action.kind}`} room={room} member={member} action={action} focus={focus} onControl={write} onResolved={() => { void refresh() }} /> : null))}
      {currentIntent?.unknown && <ComposerNotices fallbackFocus={focus} notices={[{ id: 'unknown', tone: 'error', content: m.group_unknown(), action: { label: m.refresh(), run: () => { const id = currentIntent.id; void api.fetchGroupReceipt(roomId, id).then((receipt) => { void refresh(); if (receipt.outcome === 'confirmed') setIntent((current) => current?.id === id ? null : current) }).catch(showErrorToast) } } }]} />}
      {currentRename?.unknown && <ComposerNotices fallbackFocus={focus} notices={[{ id: 'rename-unknown', tone: 'error', content: m.group_unknown(), action: { label: m.refresh(), run: () => { const pending = currentRename; void api.fetchGroup(roomId).then((next) => { if (next.room?.identity !== pending.identity) return; qc.setQueryData(key, next); if (next.room.name === pending.value) setRenameIntent((current) => current?.id === pending.id ? null : current) }).catch(showErrorToast) } } }]} />}
    </div>
    {room && !room.disbanded && <Composer key={room.identity} settings={settings.data} room={{ identity: room.identity, maxUploadBytes: room.max_upload_bytes, maxAttachments: room.attachment_limit, canSend: room.actions.includes('send') && !currentIntent && before === undefined,
      onSend: send, onUpload: async (file) => { const result = await api.uploadGroupFile(roomId, room.identity, file); if (!result.attachment || result.outcome !== 'confirmed') throw new Error(m.group_write_refused()); return result.attachment } }} />}
    <Dialog open={currentDraft !== null} onOpenChange={(open) => { if (!open) setRenameDraft(null) }} title={m.rename()}><form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); renameRoom() }}><TextInput value={currentDraft?.value ?? ''} aria-label={m.group_name()} onChange={(e) => setRenameDraft((current) => current ? { ...current, value: e.target.value } : current)} required maxLength={GROUP_ROOM_NAME_LIMIT} /><Button type="submit">{m.save()}</Button></form></Dialog>
  </div>
}


/** Native Retry/Discard use the shared optimistic prompt-answer and status-chip owners. */
function GroupRecoveryAction({ room, member, action, focus, onControl, onResolved }: {
  room: GroupRoom; member: GroupRoom['members'][number]; action: GroupRoom['members'][number]['actions'][number];
  focus: RefObject<HTMLElement | null>; onControl: (operation: GroupOperation) => Promise<unknown>; onResolved: () => void
}) {
  const resource = `group:${room.identity}:${action.member_id}:${action.task_id}:${action.execution_generation}:${action.kind}`
  const { answer, answered } = usePromptAnswer({
    resource: () => resource, queryKey: ['groups'],
    send: () => onControl({ action: action.kind === 'retry' ? 'retry' : 'discard', room_id: room.id, member_id: member.member_id, task_id: action.task_id, execution_generation: action.execution_generation }),
    waiting: () => groupActionWaiting(room, action),
    onAnswered: onResolved,
  })
  if (answered(resource)) return null
  return <ComposerNotices fallbackFocus={focus} notices={[{ id: resource, content: <span>{member.display_name || member.profile} · {phaseLabel[member.phase]()}</span>, action: { label: action.kind === 'retry' ? m.retry() : m.discard(), run: () => answer(undefined) } }]} />
}

async function groupActionWaiting(room: GroupRoom, action: GroupRoom['members'][number]['actions'][number]): Promise<boolean> {
  const next = (await api.fetchGroup(room.id)).room
  if (!next) return true
  return next.identity === room.identity && next.members.some((member) => member.member_id === action.member_id && member.actions.some((current) => current.kind === action.kind && current.task_id === action.task_id && current.execution_generation === action.execution_generation && current.request_id === action.request_id))
}
