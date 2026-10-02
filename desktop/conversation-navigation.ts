import type { WebContents } from 'electron'

// Use Slack's sidebar routing so channel changes keep its realtime socket alive.
export async function navigateConversation(contents: WebContents, channel: string, query: string) {
  if (!contents.getURL().startsWith('https://app.slack.com/client/')) throw new Error('Slack is not ready.')
  await contents.executeJavaScript(`(async () => {
    const channel = ${JSON.stringify(channel)};
    const findRow = () => document.querySelector('[data-qa-channel-sidebar-channel-id="' + channel + '"]');
    const row = findRow();
    if (row) { row.click(); return; }
    const input = document.querySelector('[data-qa="sidebar-text-filter-input_input"]');
    if (!input) throw new Error('Slack conversation search is not ready.');
    const previous = input.value;
    const setValue = (value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    try {
      setValue(${JSON.stringify(query)});
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const match = findRow();
        if (match) { match.click(); return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('Slack could not find this conversation.');
    } finally { setValue(previous); }
  })()`)
}
