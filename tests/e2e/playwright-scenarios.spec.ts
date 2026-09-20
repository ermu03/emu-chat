import { expect, test, type Page } from "@playwright/test";

const defaultSessionId = "ses_test_1";

test.describe("emu-chat local Fake Hermes smoke flows", () => {
  test.describe.configure({ mode: "serial" });

  test("loads the workbench with the Fake Hermes session and status", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByText("Hermes 在线", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Test session", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Hello Hermes", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();
  });

  test("creates a conversation through the visible workbench control", async ({
    page,
  }) => {
    await page.goto("/");
    const title = "E2E created conversation";
    page.once("dialog", (dialog) => dialog.accept(title));

    await page.getByRole("button", { name: /新建会话/ }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  });

  test("saves, sends, and reloads a draft through the Fake Hermes run path", async ({
    page,
  }) => {
    const conversationId = await openDefaultConversation(page);
    const payload = "E2E smoke message through Fake Hermes";
    const composer = page.getByPlaceholder(/输入消息/);

    await composer.fill(payload);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(composer).toHaveValue("");

    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api/v1/conversations/${conversationId}/messages?limit=100&order=oldest`,
        );
        if (!response.ok()) return false;
        const body = (await response.json()) as {
          items: Array<{ content: string }>;
        };
        return body.items.some((item) => item.content === payload);
      })
      .toBe(true);

    await page.reload();
    await expect(page.getByText(payload, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("main").getByText("Fake run completed.", { exact: true }),
    ).toBeVisible();
  });

  test("keeps the active conversation controls usable at a 320px viewport", async ({
    page,
  }) => {
    const conversationId = await getDefaultConversationId(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/conversations/${conversationId}`);

    await expect(
      page.getByRole("main").getByText("Test session", { exact: true }),
    ).toBeVisible();
    await expect(page.getByPlaceholder(/输入消息/)).toBeVisible();
    await page.getByRole("button", { name: "打开消息队列" }).click();
    await expect(
      page.getByRole("dialog", { name: "会话消息队列" }),
    ).toBeVisible();
  });
});

async function openDefaultConversation(page: Page): Promise<string> {
  const conversationId = await getDefaultConversationId(page);
  await page.goto(`/conversations/${conversationId}`);
  await expect(
    page.getByRole("main").getByText("Test session", { exact: true }),
  ).toBeVisible();
  return conversationId;
}

async function getDefaultConversationId(page: Page): Promise<string> {
  const response = await page.request.get(
    `/api/v1/conversations?session_id=${encodeURIComponent(defaultSessionId)}`,
  );
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    items: Array<{ conversation_id: string }>;
  };
  expect(body.items).toHaveLength(1);
  return body.items[0]!.conversation_id;
}
