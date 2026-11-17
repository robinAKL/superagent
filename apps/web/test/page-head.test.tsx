import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHead } from '../src/components/PageHead';

describe('PageHead', () => {
  it('keeps title, subtitle and actions as one header row', () => {
    const html = renderToStaticMarkup(<PageHead title="Settings" lead="Run the company workspace."><button type="button">Refresh</button></PageHead>);
    expect(html).toContain('class="page-head"');
    expect(html).toContain('<h1>Settings</h1>');
    expect(html).toContain('<p>Run the company workspace.</p>');
    expect(html).toContain('class="page-head-actions"');
    expect(html).toContain('Refresh');
  });
});
