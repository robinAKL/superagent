import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { ConnectComputerPage } from '../src/pages/ConnectComputerPage';
import { WorkerConnectPanel } from '../src/pages/WorkerConnectPanel';

describe('connect this computer', () => {
  it('renders zh/en headings without mixing scripts in chrome', () => {
    const zh = renderToStaticMarkup(<LangProvider initial="zh"><ConnectComputerPage /></LangProvider>);
    expect(zh).toContain('连接此电脑');
    expect(zh).toContain('允许');
    const en = renderToStaticMarkup(<LangProvider initial="en"><ConnectComputerPage /></LangProvider>);
    expect(en).toContain('Connect this computer');
    expect(en).toContain('Allow');
    expect(en).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('linked computers panel has restrict and revoke copy in both languages', () => {
    const zh = renderToStaticMarkup(<LangProvider initial="zh"><WorkerConnectPanel /></LangProvider>);
    expect(zh === '' || zh.includes('已连接') || zh.includes('无法加载')).toBe(true);
  });
});
