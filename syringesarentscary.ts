import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { load as loadCheerio } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

class SyringesArentScary implements Plugin.PluginBase {
  id = 'syringesarentscary';
  name = "Syringes Aren't Scary";
  icon = 'src/en/syringesarentscary/icon.png';
  site = 'https://stabbingwithasyringe.home.blog';
  version = '1.0.1';

  private translatedWorksPath =
    '/stabbingwithasyringe-translated-works/';

  private normalizePath(path: string): string {
    if (!path) return '';
    try {
      const url = new URL(path, this.site);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return path;
    }
  }

  private absoluteUrl(path: string): string {
    return new URL(path, this.site).toString();
  }

  private cleanText(text: string): string {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private getChapterNumber(title: string, fallback: number): number {
    const match = title.match(
      /(?:chapter|ch\.?)\s*(\d+(?:\.\d+)?)/i,
    );
    return match ? Number(match[1]) : fallback;
  }

  private async fetchHtml(path: string): Promise<string> {
    const response = await fetchApi(this.absoluteUrl(path));

    if (!response.ok) {
      throw new Error(`Failed to fetch ${this.absoluteUrl(path)} (${response.status})`);
    }

    return response.text();
  }

  private parseProjectLinks(html: string): Plugin.NovelItem[] {
    const $ = loadCheerio(html);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    $('.entry-content a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href');
      const name = this.cleanText(anchor.text());

      if (!href || !name) return;

      const path = this.normalizePath(href);
      if (!path) return;

      // WordPress stores project posts at the site root, not below the
      // translated-works page.
      let absolute: URL;
      try {
        absolute = new URL(href, this.site);
      } catch {
        return;
      }

      if (absolute.hostname !== new URL(this.site).hostname) return;

      const ignoredPaths = new Set([
        '/',
        this.translatedWorksPath,
        '/contact/',
        '/give-a-thank-you-for-the-chapter/',
      ]);

      if (ignoredPaths.has(absolute.pathname)) return;
      if (
        absolute.pathname.startsWith('/wp-') ||
        absolute.pathname.startsWith('/page/') ||
        /\.(?:jpg|jpeg|png|gif|webp|svg|css|js)$/i.test(absolute.pathname)
      ) {
        return;
      }

      if (seen.has(path)) return;
      seen.add(path);

      novels.push({
        name,
        path,
        cover: defaultCover,
      });
    });

    return novels;
  }

  async popularNovels(
    pageNo: number,
    _options: Plugin.PopularNovelsOptions<undefined>,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];

    const html = await this.fetchHtml(this.translatedWorksPath);
    return this.parseProjectLinks(html);
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo !== 1) return [];

    const html = await this.fetchHtml(this.translatedWorksPath);
    const novels = this.parseProjectLinks(html);
    const query = searchTerm.trim().toLowerCase();

    if (!query) return novels;

    return novels.filter((novel) =>
      novel.name.toLowerCase().includes(query),
    );
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const path = this.normalizePath(novelPath);
    const html = await this.fetchHtml(path);
    const $ = loadCheerio(html);

    const content = $('.entry-content').first();

    const name =
      this.cleanText($('h1.entry-title').first().text()) ||
      this.cleanText($('h1').first().text()) ||
      'Untitled';

    const cover =
      $('meta[property="og:image"]').attr('content') ||
      content.find('img').first().attr('src') ||
      defaultCover;

    let author = '';
    const authorText = this.cleanText(content.text()).match(
      /(?:^|\n)\s*Author:\s*([^\n]+)/i,
    );
    if (authorText) author = authorText[1].trim();

    const summaryParts: string[] = [];
    let reachedToc = false;

    content.children().each((_, element) => {
      const tag = element.tagName?.toLowerCase();
      const text = this.cleanText($(element).text());

      if (tag === 'h2' && /table of contents/i.test(text)) {
        reachedToc = true;
        return;
      }

      if (reachedToc || !text) return;

      if (
        /^(author:|original webnovel link)/i.test(text) ||
        /^warning\./i.test(text)
      ) {
        return;
      }

      if (tag === 'p') summaryParts.push(text);
    });

    const summary = summaryParts.slice(0, 8).join('\n\n');

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();
    let chapterIndex = 0;

    content.find('a[href]').each((_, element) => {
      const anchor = $(element);
      const href = anchor.attr('href');
      const title = this.cleanText(anchor.text());

      if (!href || !title) return;

      const chapterPath = this.normalizePath(href);
      if (!chapterPath || chapterPath === path) return;
      if (seen.has(chapterPath)) return;

      // TOC links are identifiable by chapter/prologue/epilogue/omake labels.
      const looksLikeChapter =
        /\bchapter\b/i.test(title) ||
        /\bprologue\b/i.test(title) ||
        /\bepilogue\b/i.test(title) ||
        /\bomake\b/i.test(title) ||
        /\bextra\b/i.test(title);

      if (!looksLikeChapter) return;

      seen.add(chapterPath);
      chapterIndex++;

      chapters.push({
        name: title,
        path: chapterPath,
        chapterNumber: this.getChapterNumber(title, chapterIndex),
      });
    });

    const resolvedCover =
      cover === defaultCover
        ? defaultCover
        : new URL(cover, this.site).toString();

    return {
      path,
      name,
      cover: resolvedCover,
      author,
      genres: 'English,Translation',
      status: NovelStatus.Unknown,
      summary,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const path = this.normalizePath(chapterPath);
    const html = await this.fetchHtml(path);
    const $ = loadCheerio(html);

    const content = $('.entry-content').first().clone();

    if (!content.length) return '';

    content.find(
      [
        'script',
        'style',
        'noscript',
        'iframe',
        'form',
        '.sharedaddy',
        '.jp-relatedposts',
        '.comments-area',
        '.comment-respond',
        '.entry-footer',
        '.post-navigation',
        '.wp-block-buttons',
      ].join(','),
    ).remove();

    // Remove WordPress's previous/TOC/next links from the reading body.
    content.find('a').each((_, element) => {
      const anchor = $(element);
      const text = this.cleanText(anchor.text());
      const href = anchor.attr('href') || '';

      if (
        /^(previous chapter|table of contents|next chapter)$/i.test(text) ||
        /leave a comment|support me on patreon/i.test(text) ||
        /patreon\.com/i.test(href)
      ) {
        anchor.replaceWith('');
      }
    });

    // Keep chapter images, but discard obvious WordPress tracking pixels.
    content.find('img').each((_, element) => {
      const src = $(element).attr('src') || '';
      const alt = $(element).attr('alt') || '';

      if (
        /pixel\.wp\.com/i.test(src) ||
        /gravatar/i.test(src) ||
        /tracking|avatar|pixel/i.test(alt)
      ) {
        $(element).remove();
      }
    });

    return content.html()?.trim() || '';
  }

  resolveUrl = (path: string) => this.absoluteUrl(path);
}

export default new SyringesArentScary();
