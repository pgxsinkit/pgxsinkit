import { useParams } from "@tanstack/react-router";

import { TeamPageShell } from "../components/team-page-shell";
import { ChatView } from "../features/chat";

export function TeamChatRoute() {
  const { teamId } = useParams({ from: "/team/$teamId/chat" });
  return (
    <TeamPageShell teamId={teamId} tab="chat">
      <ChatView teamId={teamId} />
    </TeamPageShell>
  );
}
