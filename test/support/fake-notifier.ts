import type { Notification, Notifier } from '../../src/server/notifier.ts';

// Records what would have been shown.
export class FakeNotifier implements Notifier {
  readonly sent: Notification[] = [];

  notify(notification: Notification): void {
    this.sent.push(notification);
  }
}
