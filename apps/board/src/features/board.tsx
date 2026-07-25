import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Box,
  Button,
  Card,
  Drawer,
  Group,
  Menu,
  NavLink,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { type KeyboardEvent, useRef, useState } from "react";

import type { IssueActions } from "../board/use-issue-actions";
import {
  type IssueConvergence,
  type IssueRow,
  type IssueStatus,
  PRIORITY_META,
  type ProfileRow,
  type ServerIssueValue,
  STATUS_LABEL,
  STATUS_ORDER,
} from "../data";
import { useIsTouch } from "../lib/use-touch";

import classes from "./board.module.css";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export interface TeamOption {
  id: string;
  name: string;
}

const CHECK = (
  <Text size="xs" c="blue">
    ✓
  </Text>
);

function AssigneeAvatar({ profile }: { profile: ProfileRow | undefined }) {
  if (profile == null) {
    return (
      <Tooltip label="Unassigned">
        <Avatar size="sm" radius="xl" color="gray" variant="light">
          ?
        </Avatar>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={profile.displayName}>
      <Avatar size="sm" radius="xl" color={profile.avatarColor}>
        {initials(profile.displayName)}
      </Avatar>
    </Tooltip>
  );
}

/**
 * The per-card actions menu (board Phase 5): Status + Assignee submenus, plus an Admin-only
 * "Move to team". Every item is a single optimistic `issue.update` via {@link IssueActions}. It is
 * the keyboard-accessible twin of drag-to-move — drag changes Status with the mouse, this menu does
 * the same (and reassign / cross-team move) from the keyboard. Wrapped in a `draggable` span whose
 * `onDragStart` is cancelled so grabbing the kebab never starts a card drag.
 */
function IssueMenu({
  issue,
  assignable,
  moveTeams,
  actions,
}: {
  issue: IssueRow;
  assignable: readonly ProfileRow[];
  moveTeams: readonly TeamOption[];
  actions: IssueActions;
}) {
  return (
    <span
      draggable
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Menu shadow="md" width={210} position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Issue actions">
            <Text size="sm" fw={700} lh={1}>
              ⋯
            </Text>
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Sub>
            <Menu.Sub.Target>
              <Menu.Sub.Item>Status</Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown>
              {STATUS_ORDER.map((status) => (
                <Menu.Item
                  key={status}
                  rightSection={issue.status === status ? CHECK : null}
                  onClick={() => void actions.setStatus(issue.id, status)}
                >
                  {STATUS_LABEL[status]}
                </Menu.Item>
              ))}
            </Menu.Sub.Dropdown>
          </Menu.Sub>

          <Menu.Sub>
            <Menu.Sub.Target>
              <Menu.Sub.Item>Assignee</Menu.Sub.Item>
            </Menu.Sub.Target>
            <Menu.Sub.Dropdown>
              <Menu.Item
                rightSection={issue.assigneeId == null ? CHECK : null}
                onClick={() => void actions.setAssignee(issue.id, null)}
              >
                Unassigned
              </Menu.Item>
              {assignable.map((profile) => (
                <Menu.Item
                  key={profile.id}
                  leftSection={
                    <Avatar size={18} radius="xl" color={profile.avatarColor}>
                      {initials(profile.displayName)}
                    </Avatar>
                  }
                  rightSection={issue.assigneeId === profile.id ? CHECK : null}
                  onClick={() => void actions.setAssignee(issue.id, profile.id)}
                >
                  {profile.displayName}
                </Menu.Item>
              ))}
            </Menu.Sub.Dropdown>
          </Menu.Sub>

          {moveTeams.length > 0 && (
            <>
              <Menu.Divider />
              <Menu.Sub>
                <Menu.Sub.Target>
                  <Menu.Sub.Item>Move to team</Menu.Sub.Item>
                </Menu.Sub.Target>
                <Menu.Sub.Dropdown>
                  {moveTeams.map((team) => (
                    <Menu.Item key={team.id} onClick={() => void actions.moveToTeam(issue.id, team.id)}>
                      {team.name}
                    </Menu.Item>
                  ))}
                </Menu.Sub.Dropdown>
              </Menu.Sub>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </span>
  );
}

/**
 * The touch twin of {@link IssueMenu} (docs/mobile.md): ONE bottom sheet shared by every card, opened by
 * tapping the card whose actions it shows. Sections are deliberately FLAT — Mantine's `Menu.Sub` opens on
 * hover, which is precisely the interaction a touch device does not have — and each row runs the same
 * {@link IssueActions} write the kebab menu does, so touch and pointer share one write path. Touch drag is
 * not rebuilt: drag's only capability is changing Status, which this sheet does in a single tap.
 *
 * `issue` is looked up from the live rows by the caller on every render (never copied into state), so an
 * edit made here — or a remote change arriving while the sheet is open — is reflected immediately.
 */
function IssueSheet({
  issue,
  assignable,
  moveTeams,
  actions,
  onClose,
}: {
  issue: IssueRow | null;
  assignable: readonly ProfileRow[];
  moveTeams: readonly TeamOption[];
  actions: IssueActions;
  onClose: () => void;
}) {
  // The selection clears the instant a row is tapped, but the Drawer keeps sliding out for another frame
  // or two — so the body renders the last open selection through the close transition instead of
  // collapsing into an empty sheet mid-animation. While the sheet is OPEN, `shown` is always the live row.
  const lastOpen = useRef<{
    issue: IssueRow;
    assignable: readonly ProfileRow[];
    moveTeams: readonly TeamOption[];
  } | null>(null);
  if (issue != null) lastOpen.current = { issue, assignable, moveTeams };
  const shown = issue != null ? { issue, assignable, moveTeams } : lastOpen.current;

  return (
    <Drawer
      opened={issue != null}
      onClose={onClose}
      position="bottom"
      title={shown?.issue.title}
      padding="md"
      // A sheet hugs its content. Mantine's `size` sets a FIXED height for a bottom Drawer (and "auto"
      // is not a size it understands), so the height is relaxed here and capped so a long list still
      // scrolls inside the sheet instead of covering the board.
      styles={{ content: { height: "auto", maxHeight: "85%" } }}
    >
      {shown != null && (
        <Stack gap="lg">
          <Stack gap={2}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
              Status
            </Text>
            {STATUS_ORDER.map((status) => (
              <NavLink
                key={status}
                label={STATUS_LABEL[status]}
                active={shown.issue.status === status}
                rightSection={shown.issue.status === status ? CHECK : null}
                onClick={() => {
                  void actions.setStatus(shown.issue.id, status);
                  onClose();
                }}
              />
            ))}
          </Stack>

          <Stack gap={2}>
            <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
              Assignee
            </Text>
            <NavLink
              label="Unassigned"
              active={shown.issue.assigneeId == null}
              rightSection={shown.issue.assigneeId == null ? CHECK : null}
              onClick={() => {
                void actions.setAssignee(shown.issue.id, null);
                onClose();
              }}
            />
            {shown.assignable.map((profile) => (
              <NavLink
                key={profile.id}
                label={profile.displayName}
                active={shown.issue.assigneeId === profile.id}
                leftSection={
                  <Avatar size={22} radius="xl" color={profile.avatarColor}>
                    {initials(profile.displayName)}
                  </Avatar>
                }
                rightSection={shown.issue.assigneeId === profile.id ? CHECK : null}
                onClick={() => {
                  void actions.setAssignee(shown.issue.id, profile.id);
                  onClose();
                }}
              />
            ))}
          </Stack>

          {shown.moveTeams.length > 0 && (
            <Stack gap={2}>
              <Text size="xs" tt="uppercase" c="dimmed" fw={600}>
                Move to team
              </Text>
              {shown.moveTeams.map((team) => (
                <NavLink
                  key={team.id}
                  label={team.name}
                  onClick={() => {
                    void actions.moveToTeam(shown.issue.id, team.id);
                    onClose();
                  }}
                />
              ))}
            </Stack>
          )}
        </Stack>
      )}
    </Drawer>
  );
}

/**
 * Inline reject-if-stale conflict surface (board Phase 6 / ADR-0015). The optimistic write was
 * declined because the row moved on the server; the toolkit KEEPS the optimistic overlay (never a
 * silent snap-back), so the card still shows the rejected value. This banner names the server's
 * current value and offers the two resolutions: re-apply ("Keep mine", a fresh write that re-bases
 * and converges) or `discardConflict` ("Use server's", drop the overlay → fall back to the server
 * value). `serverValue` is read from the synced base table (data.useServerIssueValues).
 */
function ConflictNotice({
  issue,
  serverValue,
  profiles,
  actions,
}: {
  issue: IssueRow;
  serverValue: ServerIssueValue | undefined;
  profiles: Map<string, ProfileRow>;
  actions: IssueActions;
}) {
  const serverStatusLabel =
    serverValue != null ? (STATUS_LABEL[serverValue.status as IssueStatus] ?? serverValue.status) : null;
  const serverAssignee = serverValue?.assigneeId != null ? profiles.get(serverValue.assigneeId) : undefined;
  const assigneeChanged = serverValue != null && serverValue.assigneeId !== issue.assigneeId;
  return (
    <Alert
      color="orange"
      variant="light"
      radius="sm"
      p="xs"
      title="Edited by someone else"
      icon={<Text fw={700}>!</Text>}
    >
      <Stack gap={8}>
        <Text size="xs">
          {serverValue != null ? (
            <>
              The server now has this in <b>{serverStatusLabel}</b>
              {assigneeChanged
                ? serverAssignee != null
                  ? `, assigned to ${serverAssignee.displayName}`
                  : ", unassigned"
                : ""}
              . Your change wasn&apos;t applied.
            </>
          ) : (
            <>Your change wasn&apos;t applied — the issue moved on the server.</>
          )}
        </Text>
        {/* Both resolutions stop the click here: on touch the whole card is the bottom sheet's target,
            and resolving a conflict must never double as "open the actions sheet". */}
        <Group gap="xs">
          <Button
            size="compact-xs"
            color="orange"
            onClick={(event) => {
              event.stopPropagation();
              void actions.keepMine(issue.id, {
                status: issue.status as IssueStatus,
                assigneeId: issue.assigneeId,
              });
            }}
          >
            Keep mine
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            onClick={(event) => {
              event.stopPropagation();
              void actions.discardConflict(issue.id);
            }}
          >
            Use server&apos;s
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}

/**
 * The inline convergence dot (board Phase 8): one glance at where an Issue sits in the sync cycle,
 * derived from the toolkit's `issue_sync_state` (ADR-0011). Shown only when the row is NOT fully
 * converged, so a quiet board stays clean — a quarantine or conflict outranks a plain pending write.
 */
function ConvergenceDot({ convergence }: { convergence: IssueConvergence | undefined }) {
  if (convergence == null) return null;
  let color: string | null = null;
  let label = "";
  if (convergence.quarantinedCount > 0) {
    color = "red";
    label = "Rejected — quarantined (see Sync inspector)";
  } else if (convergence.conflictState != null) {
    color = "orange";
    label = "Conflict — edited by someone else";
  } else if (convergence.pendingCount > 0) {
    color = "yellow";
    label = "Syncing — change queued, awaiting the server";
  }
  if (color == null) return null;
  return (
    <Tooltip label={label} withArrow position="top">
      <Box
        w={8}
        h={8}
        style={{ borderRadius: "50%", backgroundColor: `var(--mantine-color-${color}-6)`, flexShrink: 0 }}
        aria-label={label}
      />
    </Tooltip>
  );
}

export function IssueCard({
  issue,
  profiles,
  teamName,
  assignable,
  moveTeams,
  actions,
  convergence,
  serverValue,
  onDragStart,
  onDragEnd,
  onSelect,
}: {
  issue: IssueRow;
  profiles: Map<string, ProfileRow>;
  teamName?: string;
  assignable: readonly ProfileRow[];
  moveTeams: readonly TeamOption[];
  actions: IssueActions;
  convergence?: IssueConvergence;
  serverValue?: ServerIssueValue;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Touch only (docs/mobile.md): when present the whole card opens the shared bottom sheet and the kebab
   * menu is dropped. Absent on pointer devices, where drag + the kebab menu are unchanged. */
  onSelect?: () => void;
}) {
  const priority = PRIORITY_META[issue.priority] ?? PRIORITY_META["none"]!;
  const conflicted = convergence?.conflictState != null;
  // Button semantics ride along so TalkBack/VoiceOver announce the card as actionable, and a hardware
  // keyboard on a touch device can still reach it.
  const selectProps =
    onSelect != null
      ? {
          onClick: onSelect,
          role: "button",
          tabIndex: 0,
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            // The card only answers for ITSELF: an Enter/Space that activated a control inside it (the
            // ConflictNotice buttons) bubbles up here, and resolving a conflict must not also open the sheet.
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect();
            }
          },
        }
      : {};
  return (
    <Card
      withBorder
      padding="sm"
      radius="md"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", issue.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      style={{ cursor: onSelect != null ? "pointer" : "grab" }}
      {...selectProps}
    >
      <Stack gap={8}>
        <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
          <Group gap={6} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
            <ConvergenceDot convergence={convergence} />
            <Text size="sm" fw={500} lineClamp={2}>
              {issue.title}
            </Text>
          </Group>
          {onSelect == null && (
            <IssueMenu issue={issue} assignable={assignable} moveTeams={moveTeams} actions={actions} />
          )}
        </Group>
        <Group justify="space-between" gap="xs">
          <Group gap={6}>
            {issue.priority !== "none" && (
              <Badge size="xs" variant="light" color={priority.color}>
                {priority.label}
              </Badge>
            )}
            {teamName != null && (
              <Badge size="xs" variant="outline" color="gray">
                {teamName}
              </Badge>
            )}
          </Group>
          <AssigneeAvatar profile={issue.assigneeId != null ? profiles.get(issue.assigneeId) : undefined} />
        </Group>
        {conflicted && <ConflictNotice issue={issue} serverValue={serverValue} profiles={profiles} actions={actions} />}
      </Stack>
    </Card>
  );
}

/**
 * The status-column board surface. Cards are draggable; each column is a drop target that sets the
 * dragged Issue's Status (an optimistic `issue.update`). Pass `teamNameById` for the cross-team
 * `/all` view so each card is labelled with its Team. `assignableByTeam` provides the assignee
 * candidates for each Issue's Team; `moveTeams` (Admin only) enables cross-team move.
 */
export function BoardColumns({
  issues,
  profiles,
  actions,
  assignableByTeam,
  convergenceById,
  serverValueById,
  teamNameById,
  moveTeams = [],
}: {
  issues: readonly IssueRow[];
  profiles: Map<string, ProfileRow>;
  actions: IssueActions;
  assignableByTeam: Map<string, ProfileRow[]>;
  convergenceById?: Map<string, IssueConvergence>;
  serverValueById?: Map<string, ServerIssueValue>;
  teamNameById?: Map<string, string>;
  moveTeams?: readonly TeamOption[];
}) {
  const dragged = useRef<IssueRow | null>(null);
  const [overStatus, setOverStatus] = useState<IssueStatus | null>(null);

  // Touch (docs/mobile.md): no drag, no kebab — a tap opens one shared bottom sheet. Only the id is held
  // in state; the row itself is re-read from `issues` every render so the open sheet tracks live updates
  // (its own writes and remote ones alike) and closes itself if the Issue leaves the view.
  const isTouch = useIsTouch();
  const [sheetIssueId, setSheetIssueId] = useState<string | null>(null);
  const sheetIssue = sheetIssueId == null ? null : (issues.find((issue) => issue.id === sheetIssueId) ?? null);

  const handleDrop = (status: IssueStatus) => {
    const issue = dragged.current;
    dragged.current = null;
    setOverStatus(null);
    if (issue != null && issue.status !== status) void actions.setStatus(issue.id, status);
  };

  return (
    <>
      <Group align="flex-start" gap="md" wrap="nowrap" className={classes["columns"]} style={{ overflowX: "auto" }}>
        {STATUS_ORDER.map((status) => {
          const columnIssues = issues.filter((issue) => issue.status === status);
          const isOver = overStatus === status;
          return (
            <Stack
              key={status}
              gap="xs"
              // The column's identity in the DOM (same role as `data-authenticated-shell` on the shell):
              // "which column is this card in?" is otherwise only answerable by walking up from a header
              // label, and the mobile smoke has to DERIVE a card's current Status rather than assume it —
              // it runs after the desktop suite has already moved fixtures around.
              data-status={status}
              // Viewport-relative on a phone so the next column peeks at the edge as the swipe
              // affordance; the desktop column keeps its exact 264px from `xs` up.
              miw={{ base: "min(80vw, 340px)", xs: 264 }}
              w={{ base: "min(80vw, 340px)", xs: 264 }}
              p={4}
              className={classes["column"]}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (overStatus !== status) setOverStatus(status);
              }}
              onDrop={() => handleDrop(status)}
              style={{
                borderRadius: "var(--mantine-radius-md)",
                outline: isOver ? "2px dashed var(--mantine-color-blue-5)" : "2px dashed transparent",
                background: isOver ? "var(--mantine-color-blue-light)" : undefined,
                transition: "background 120ms ease",
              }}
            >
              <Group justify="space-between" px={4}>
                <Text size="sm" fw={600}>
                  {STATUS_LABEL[status]}
                </Text>
                <Badge size="sm" variant="default">
                  {columnIssues.length}
                </Badge>
              </Group>
              <Stack gap="xs" mih={40}>
                {columnIssues.map((issue) => {
                  const teamName = teamNameById?.get(issue.teamId);
                  const convergence = convergenceById?.get(issue.id);
                  const serverValue = serverValueById?.get(issue.id);
                  return (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      profiles={profiles}
                      assignable={assignableByTeam.get(issue.teamId) ?? []}
                      moveTeams={moveTeams.filter((team) => team.id !== issue.teamId)}
                      actions={actions}
                      onDragStart={() => {
                        dragged.current = issue;
                      }}
                      onDragEnd={() => {
                        dragged.current = null;
                        setOverStatus(null);
                      }}
                      {...(teamName != null ? { teamName } : {})}
                      {...(convergence != null ? { convergence } : {})}
                      {...(serverValue != null ? { serverValue } : {})}
                      {...(isTouch ? { onSelect: () => setSheetIssueId(issue.id) } : {})}
                    />
                  );
                })}
                {columnIssues.length === 0 && (
                  <Text size="xs" c="dimmed" px={4}>
                    No issues
                  </Text>
                )}
              </Stack>
            </Stack>
          );
        })}
      </Group>
      {isTouch && (
        <IssueSheet
          issue={sheetIssue}
          assignable={sheetIssue != null ? (assignableByTeam.get(sheetIssue.teamId) ?? []) : []}
          moveTeams={sheetIssue != null ? moveTeams.filter((team) => team.id !== sheetIssue.teamId) : []}
          actions={actions}
          onClose={() => setSheetIssueId(null)}
        />
      )}
    </>
  );
}
