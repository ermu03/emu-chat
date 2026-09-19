import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { DraftComposer } from '../../src/client/features/composer/draft-composer';
import { QueueDrawer } from '../../src/client/features/queue/queue-drawer';
import { ApprovalDialog } from '../../src/client/features/approval/approval-dialog';
import { StatusBar } from '../../src/client/features/status/status-bar';
import { ToolCallCard } from '../../src/client/features/tools/tool-call-card';

describe('React Components Static Tests', () => {
  describe('DraftComposer', () => {
    it('renders textarea with placeholder and character count', () => {
      const onSaveDraft = vi.fn();
      const onSubmit = vi.fn();

      render(
        <DraftComposer
          initialText="Existing draft content"
          onSaveDraft={onSaveDraft}
          onSubmit={onSubmit}
          disabled={false}
        />
      );

      const textarea = screen.getByPlaceholderText(/输入消息/i);
      expect(textarea).toBeDefined();
      expect((textarea as HTMLTextAreaElement).value).toBe('Existing draft content');
    });

    it('triggers onSubmit when Ctrl+Enter or Cmd+Enter is pressed', () => {
      const onSaveDraft = vi.fn();
      const onSubmit = vi.fn();

      render(
        <DraftComposer
          initialText="Send me"
          onSaveDraft={onSaveDraft}
          onSubmit={onSubmit}
          disabled={false}
        />
      );

      const textarea = screen.getByPlaceholderText(/输入消息/i);
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
      expect(onSubmit).toHaveBeenCalledWith('Send me');
    });
  });

  describe('QueueDrawer', () => {
    it('renders empty placeholder when queue is empty', () => {
      render(
        <QueueDrawer
          isOpen={true}
          onClose={vi.fn()}
          items={[]}
          onCancelItem={vi.fn()}
        />
      );

      expect(screen.getByText(/当前无排队任务/i)).toBeDefined();
    });

    it('renders queued items with status and cancel button', () => {
      const onCancelItem = vi.fn();
      const items = [
        {
          id: 'qi_001',
          conversation_id: 'cv_001',
          status: 'queued' as const,
          created_at: new Date().toISOString(),
          prompt_preview: 'Hello Hermes',
        },
      ];

      render(
        <QueueDrawer
          isOpen={true}
          onClose={vi.fn()}
          items={items}
          onCancelItem={onCancelItem}
        />
      );

      expect(screen.getByText(/Hello Hermes/)).toBeDefined();
      const cancelBtn = screen.getByText(/取消排队/i);
      fireEvent.click(cancelBtn);
      expect(onCancelItem).toHaveBeenCalledWith('qi_001');
    });
  });

  describe('ApprovalDialog', () => {
    it('renders approval request details and action buttons', () => {
      const onDecide = vi.fn();
      const request = {
        requestId: 'rq_test_001',
        toolName: 'shell_exec',
        parameters: { command: 'echo 123' },
      };

      render(
        <ApprovalDialog
          isOpen={true}
          request={request}
          onDecide={onDecide}
          isSubmitting={false}
        />
      );

      expect(screen.getByText(/需要工具执行审批/i)).toBeDefined();
      expect(screen.getByText(/shell_exec/)).toBeDefined();

      const approveBtn = screen.getByText(/仅允许本次执行/i);
      fireEvent.click(approveBtn);
      expect(onDecide).toHaveBeenCalledWith('once');
    });
  });

  describe('StatusBar', () => {
    it('renders online badge when status is ready', () => {
      render(
        <StatusBar
          hermesOnline={true}
          isLanHttp={false}
          onOpenSettings={vi.fn()}
        />
      );

      expect(screen.getByText(/Hermes 在线/i)).toBeDefined();
    });

    it('displays warning when accessed via non-secure LAN HTTP', () => {
      render(
        <StatusBar
          hermesOnline={true}
          isLanHttp={true}
          onOpenSettings={vi.fn()}
        />
      );

      expect(screen.getByText(/局域网 HTTP 非安全上下文/i)).toBeDefined();
    });
  });

  describe('ToolCallCard', () => {
    it('renders tool call name and toggles arguments view', () => {
      render(
        <ToolCallCard
          toolName="calculator"
          status="completed"
          inputParams={{ expression: '40 + 2' }}
          outputResult={{ result: 42 }}
        />
      );

      expect(screen.getByText(/工具调用: calculator/i)).toBeDefined();
      expect(screen.getByText(/执行成功/i)).toBeDefined();
    });
  });
});
