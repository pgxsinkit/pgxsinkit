import { Alert, Button, Card, Center, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAuth } from "../auth/auth";

// The seeded demo identities (scripts/seed-board.ts). Each signs in with a real GoTrue password; the
// note is the membership the read path will scope them to — handy for eyeballing the fan-out.
const IDENTITIES: ReadonlyArray<{ email: string; name: string; note: string; admin?: boolean }> = [
  { email: "alice@board.local", name: "Alice Okafor", note: "Platform · Growth" },
  { email: "bob@board.local", name: "Bob Nilsson", note: "Platform" },
  { email: "carol@board.local", name: "Carol Mensah", note: "Platform" },
  { email: "dave@board.local", name: "Dave Ibarra", note: "Growth" },
  { email: "erin@board.local", name: "Erin Flores", note: "Growth" },
  { email: "frank@board.local", name: "Frank Petrov", note: "Design" },
  { email: "grace@board.local", name: "Grace Lindqvist", note: "Design" },
  { email: "heidi@board.local", name: "Heidi Park", note: "Design" },
  { email: "admin@board.local", name: "Admin", note: "all teams (admin bypass)", admin: true },
];

export function LoginRoute() {
  const { session, signInAs } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session) void navigate({ to: "/" });
  }, [session, navigate]);

  const handleSignIn = async (email: string) => {
    setPending(email);
    setError(null);
    try {
      await signInAs(email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(null);
    }
  };

  return (
    <Center h="70vh">
      <Card withBorder w={440} padding="lg" radius="md">
        <Stack>
          <div>
            <Title order={3}>Sign in to the board</Title>
            <Text size="sm" c="dimmed">
              One-click demo identities, seeded through the GoTrue admin API. Each signs in with a real password — the
              edge functions verify the access token, so the read path is scoped to the identity you pick.
            </Text>
          </div>

          {error != null && (
            <Alert color="red" title="Sign-in failed" variant="light">
              {error}
              <Text size="xs" mt={4}>
                Is the stack up (`bun run infra:up`) and seeded (`bun run seed:board`)?
              </Text>
            </Alert>
          )}

          <Stack gap="xs">
            {IDENTITIES.map((identity) => (
              <Button
                key={identity.email}
                variant={identity.admin ? "filled" : "default"}
                justify="space-between"
                fullWidth
                rightSection={
                  <Text span size="xs" {...(identity.admin ? {} : { c: "dimmed" })}>
                    {identity.note}
                  </Text>
                }
                loading={pending === identity.email}
                disabled={pending != null && pending !== identity.email}
                onClick={() => void handleSignIn(identity.email)}
              >
                {identity.name}
              </Button>
            ))}
          </Stack>
        </Stack>
      </Card>
    </Center>
  );
}
