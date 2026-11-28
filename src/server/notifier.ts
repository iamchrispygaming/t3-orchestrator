// The Notifier port: OS notifications raised by the server when something needs
// the user. Batching, the Needs-you count and click-through URLs come with #44.

export type Notification = { title: string; body: string };

export interface Notifier {
  notify(notification: Notification): void;
}

export const silentNotifier: Notifier = { notify: () => {} };
