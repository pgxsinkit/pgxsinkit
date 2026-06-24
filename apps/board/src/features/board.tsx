import { ActionIcon, Avatar, Badge, Card, Group, Menu, Stack, Text, Tooltip } from "@mantine/core";
import { useRef, useState } from "react";

import type { IssueActions } from "../board/use-issue-actions";
import { type IssueRow, type IssueStatus, PRIORITY_META, type ProfileRow, STATUS_LABEL, STATUS_ORDER } from "../data";

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

export function IssueCard({
  issue,
  profiles,
  teamName,
  assignable,
  moveTeams,
  actions,
  onDragStart,
  onDragEnd,
}: {
  issue: IssueRow;
  profiles: Map<string, ProfileRow>;
  teamName?: string;
  assignable: readonly ProfileRow[];
  moveTeams: readonly TeamOption[];
  actions: IssueActions;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const priority = PRIORITY_META[issue.priority] ?? PRIORITY_META["none"]!;
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
          <Text size="sm" fw={500} lineClamp={2}>
            {issue.title}
          </Text>
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
  teamNameById,
  moveTeams = [],
}: {
  issues: readonly IssueRow[];
  profiles: Map<string, ProfileRow>;
  actions: IssueActions;
  assignableByTeam: Map<string, ProfileRow[]>;
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
