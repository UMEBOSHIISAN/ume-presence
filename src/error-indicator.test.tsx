import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { AppFrame } from './App';
import { nextIndicator } from './error-indicator';

describe('visual-only indicator', () => {
  test('renders warning and error classes independently', () => {
    expect(
      renderToStaticMarkup(
        <AppFrame indicator="warning">
          <span>avatar</span>
        </AppFrame>,
      ),
    ).toContain('class="app app--warning"');
    expect(
      renderToStaticMarkup(
        <AppFrame indicator="error">
          <span>avatar</span>
        </AppFrame>,
      ),
    ).toContain('class="app app--error"');
    expect(
      renderToStaticMarkup(
        <AppFrame indicator={null}>
          <span>avatar</span>
        </AppFrame>,
      ),
    ).toContain('class="app"');
  });

  test('changes only for closed indicator events', () => {
    expect(
      nextIndicator(null, {
        type: 'indicator',
        indicator: 'warning',
      }),
    ).toBe('warning');
    expect(
      nextIndicator('warning', {
        type: 'indicator',
        indicator: 'error',
      }),
    ).toBe('error');
    expect(
      nextIndicator('error', {
        type: 'indicator',
        indicator: 'clear',
      }),
    ).toBe(null);
    expect(
      nextIndicator('warning', {
        type: 'animation',
        animation: 'TALK',
      }),
    ).toBe('warning');
  });
});
