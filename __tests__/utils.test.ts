import { parseWebDAVXml } from '../zen-fs-webdav/src/utils.ts';

describe('parseWebDAVXml getCaseInsensitive / namespace handling', () => {
  test('should parse lp1:resourcetype empty tag and detect file via getcontentlength', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response xmlns:lp2="http://apache.org/dav/props/" xmlns:lp1="DAV:">
<D:href>/dav/test/.sync.lock</D:href>
<D:propstat>
<D:prop>
<lp1:resourcetype/>
<lp1:getcontentlength>93</lp1:getcontentlength>
</D:prop>
</D:propstat>
</D:response>
</D:multistatus>`;

    const stats = parseWebDAVXml(xml, '/dav/test/');
    expect(stats).toBeDefined();
    expect(stats.length).toBeGreaterThan(0);
  const s = stats.find(st => st.path.endsWith('.sync.lock'));
  expect(s).toBeDefined();
  if (!s) throw new Error('expected stat for .sync.lock');
  expect(s.isFile).toBe(true);
  expect(s.isDirectory).toBe(false);
  });
});