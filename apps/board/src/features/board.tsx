import { ActionIcon, Alert, Avatar, Badge, Box, Button, Card, Group, Menu, Stack, Text, Tooltip } from "@mantine/core";
import { useRef, useState } from "react";

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
        <Group gap="xs">
          <Button
            size="compact-xs"
            color="orange"
            onClick={() =>
              void actions.keepMine(issue.id, {
                status: issue.status as IssueStatus,
                assigneeId: issue.assigneeId,
              })
            }
          >
            Keep mine
          </Button>
          <Button size="compact-xs" variant="default" onClick={() => void actions.discardConflict(issue.id)}>
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
}) {
  const priority = PRIORITY_META[issue.priority] ?? PRIORITY_META["none"]!;
  const conflicted = convergence?.conflictState != null;
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
      style={{ cursor: "grab" }}
    >
      <Stack gap={8}>
        <Group justify="space-between" gap="xs" wrap="nowrap" align="flex-start">
          <Group gap={6} wrap="nowrap" align="center" style={{ minWidth: 0 }}>
            <ConvergenceDot convergence={convergence} />
            <Text size="sm" fw={500} lineClamp={2}>
              {issue.title}
            </Text>
          </Group>
          <IssueMenu issue={issue} assignable={assignable} moveTeams={moveTeams} actions={actions} />
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

  const handleDrop = (status: IssueStatus) => {
    const issue = dragged.current;
    dragged.current = null;
    setOverStatus(null);
    if (issue != null && issue.status !== status) void actions.setStatus(issue.id, status);
  };

  return (
    <Group align="flex-start" gap="md" wrap="nowrap" style={{ overflowX: "auto" }}>
      {STATUS_ORDER.map((status) => {
        const columnIssues = issues.filter((issue) => issue.status === status);
        const isOver = overStatus === status;
        return (
          <Stack
            key={status}
            gap="xs"
            miw={264}
            w={264}
            p={4}
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
  );
}
