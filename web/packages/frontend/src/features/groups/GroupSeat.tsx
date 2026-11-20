import type { GroupRoom } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'

type Member = GroupRoom['members'][number]
/** A member's name and, for a seat another computer lends, that computer. */
export const seatName = (member: Member) => member.remote ? `${member.display_name || member.profile} · ${member.remote.computer_label ?? m.group_remote_computer()}` : member.display_name || member.profile
const reachLabel = { offline: () => m.group_offline(), needs_reauthorization: () => m.group_needs_reauthorization() }
/** A seat's name, then why its home gateway cannot reach a lent seat; the room header's and the list row's. */
export function GroupSeat({ member }: { member: Member }) {
  const reach = member.remote?.reachability
  return <>{seatName(member)}{reach && reach !== 'ready' && <span className="text-warning"> · {reachLabel[reach]()}</span>}</>
}
