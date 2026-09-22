import { useSyncExternalStore } from 'react';

export type TitleLanguage = 'zh' | 'original';
const storageKey = 'lmd-title-language';
const eventName = 'lmd-title-language-change';
export function titleLanguage(): TitleLanguage {
  try { return localStorage.getItem(storageKey) === 'original' ? 'original' : 'zh'; } catch { return 'zh'; }
}
export function setTitleLanguage(value: TitleLanguage) {
  try { localStorage.setItem(storageKey, value); } catch { /* Storage may be disabled. */ }
  window.dispatchEvent(new Event(eventName));
}
const subscribe = (callback: () => void) => {
  window.addEventListener(eventName, callback); window.addEventListener('storage', callback);
  return () => { window.removeEventListener(eventName, callback); window.removeEventListener('storage', callback); };
};
export const useTitleLanguage = () => useSyncExternalStore(subscribe, titleLanguage, () => 'zh' as const);
export function chooseTitle(chinese?: string, original?: string, language: TitleLanguage = titleLanguage()) {
  return language === 'original' ? original || chinese || '' : chinese || original || '';
}
export function localizedDisplay<T extends { title?: string; originalTitle?: string; seriesTitle: string; episodeTitle?: string; originalEpisodeTitle?: string; alias: string; season: number; episode: number }>(display: T, language: TitleLanguage): T & { searchTitles: string } {
  const seriesTitle = chooseTitle(display.title, display.originalTitle, language) || display.seriesTitle;
  const episodeTitle = chooseTitle(display.episodeTitle, display.originalEpisodeTitle, language);
  return { ...display, seriesTitle, episodeTitle, searchTitles: [display.title, display.originalTitle, display.episodeTitle, display.originalEpisodeTitle].filter(Boolean).join(' '), alias: `${seriesTitle} - S${String(display.season).padStart(2, '0')}E${String(display.episode).padStart(2, '0')}${episodeTitle ? ` · ${episodeTitle}` : ''}` };
}
