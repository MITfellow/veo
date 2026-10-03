/**
 * S4 tests 59–64: the notification bell.
 *
 * The thing being pinned here is mostly about *restraint*: the bell
 * must be invisible when there is nothing to say, and silent when the
 * agent is not running. A badge that is always present, or that turns
 * into an error when the backend is down, is a badge people stop
 * looking at — and then the reminder feature is back to being a row
 * in a table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationBell from './NotificationBell';
import { agent, AgentUnavailableError, type NotificationView } from '../lib/agent';

const notification = (overrides: Partial<NotificationView> = {}): NotificationView => ({
  id: 'R-1',
  text: 'Put the bins out',
  firedAt: Date.now() - 4 * 60_000,
  ownerKind: 'task',
  ownerId: 'T-1',
  sessionId: 'ses-schedule-abc',
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(agent, 'markNotificationSeen').mockResolvedValue(undefined);
});

describe('the notification bell', () => {
  it('59. renders nothing at all when there is nothing unseen', async () => {
    vi.spyOn(agent, 'notifications').mockResolvedValue({ notifications: [] });
    const { container } = render(<NotificationBell />);

    await waitFor(() => expect(agent.notifications).toHaveBeenCalled());
    expect(container.querySelector('.ntf-bell')).toBeNull();
  });

  it('60. renders nothing when the agent is not running', async () => {
    // Not an error in the window chrome. The sidebar belongs to the
    // messaging app, which works fine with no agent at all.
    vi.spyOn(agent, 'notifications').mockRejectedValue(
      new AgentUnavailableError('agent not running'),
    );
    const { container } = render(<NotificationBell />);

    await waitFor(() => expect(agent.notifications).toHaveBeenCalled());
    expect(container.querySelector('.ntf-bell')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('61. counts the unseen ones in the badge', async () => {
    vi.spyOn(agent, 'notifications').mockResolvedValue({
      notifications: [notification(), notification({ id: 'R-2', text: 'Call the vet' })],
    });
    render(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: 'Notifications: 2 unseen' });
    expect(bell.textContent).toContain('2');
  });

  it('62. lists them with how long ago they fired', async () => {
    vi.spyOn(agent, 'notifications').mockResolvedValue({
      notifications: [notification({ firedAt: Date.now() - 4 * 60_000 })],
    });
    const user = userEvent.setup();
    render(<NotificationBell />);

    await user.click(await screen.findByRole('button', { name: 'Notifications: 1 unseen' }));
    expect(screen.getByText('Put the bins out')).toBeInTheDocument();
    expect(screen.getByText('4m ago')).toBeInTheDocument();
  });

  it('63. dismissing marks it seen on the agent and clears the bell', async () => {
    const notifications = vi
      .spyOn(agent, 'notifications')
      .mockResolvedValueOnce({ notifications: [notification()] })
      .mockResolvedValue({ notifications: [] });
    const user = userEvent.setup();
    const { container } = render(<NotificationBell />);

    await user.click(await screen.findByRole('button', { name: 'Notifications: 1 unseen' }));
    await user.click(screen.getByRole('button', { name: 'Got it' }));

    // It is a fact appended to the agent's log, not local state.
    expect(agent.markNotificationSeen).toHaveBeenCalledWith('R-1');
    await waitFor(() => expect(container.querySelector('.ntf-bell')).toBeNull());
    expect(notifications).toHaveBeenCalledTimes(2);
  });

  it('64. offers to open the conversation the agent spoke in', async () => {
    vi.spyOn(agent, 'notifications').mockResolvedValue({ notifications: [notification()] });
    const onOpenSession = vi.fn();
    const user = userEvent.setup();
    render(<NotificationBell onOpenSession={onOpenSession} />);

    await user.click(await screen.findByRole('button', { name: 'Notifications: 1 unseen' }));
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(onOpenSession).toHaveBeenCalledWith('ses-schedule-abc');
  });
});
