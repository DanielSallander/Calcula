// FILENAME: src/utils/action-logger.ts
// PURPOSE: Global event listener to debug user interactions (Click/Change)
// FORMAT: [timestamp]|I|USER|ACTION <element> details

import { logger } from './logger';

const MAX_TEXT_LENGTH = 50;

/**
 * Extract relevant details from an HTML Element for logging.
 */
function getElementDetails(element: HTMLElement | null) {
  if (!element) return { tag: 'unknown', id: '', classes: '', text: '' };

  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const classes = element.className && typeof element.className === 'string'
    ? `.${element.className.split(' ').filter(c => c).join('.')}`
    : '';

  let text = element.innerText || (element as HTMLInputElement).value || '';
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > MAX_TEXT_LENGTH) {
    text = text.substring(0, MAX_TEXT_LENGTH) + '...';
  }

  return { tag, id, classes, text };
}

/**
 * Handles the event logging with compact format.
 */
function logInteraction(eventType: string, event: Event) {
  const target = event.target as HTMLElement;
  const { tag, id, classes, text } = getElementDetails(target);

  // Browser console (grouped for dev)
  const label = `[User] ${eventType.toUpperCase()} <${tag}${id}${classes}>`;
  console.groupCollapsed(label);
  console.log('Text:', text || '(empty)');
  console.log('Element:', target);
  console.groupEnd();

  // File log - compact format
  // Format: ACTION <element> text="value"
  const textPart = text ? ` text="${text}"` : '';
  logger.info('USER', `${eventType.toUpperCase()} <${tag}${id}${classes}>${textPart}`);
}

/**
 * Initializes global event listeners.
 */
export function initGlobalActionLogger() {
  if (typeof window === 'undefined') return;

  const opts = { capture: true, passive: true };

  window.addEventListener('click', (e) => logInteraction('CLICK', e), opts);
  window.addEventListener('change', (e) => logInteraction('CHANGE', e), opts);

  logger.info('SYS', 'Global Action Logger initialized');
}