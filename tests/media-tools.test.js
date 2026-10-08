const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const MT = require('../media-tools.js');

test('HLS master + media playlists', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="a"\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\nhigh/index.m3u8\n';
  const p = MT.parseHls(master, 'https://cdn.example/v/master.m3u8');
  assert.equal(p.master, true);
  assert.equal(p.variants[0].height, 1080);
  assert.equal(p.variants[0].url, 'https://cdn.example/v/high/index.m3u8');
  assert.equal(p.audio[0].url, 'https://cdn.example/v/audio/en.m3u8');
  const media = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4.0,\ns1.ts\n#EXTINF:3.5,\ns2.ts\n#EXT-X-ENDLIST\n';
  const m = MT.parseHls(media, 'https://cdn.example/v/high/index.m3u8');
  assert.equal(m.segments.length, 2);
  assert.equal(m.segments[1].seq, 8);
  assert.equal(m.segments[0].key.url, 'https://cdn.example/v/high/key.bin');
  assert.equal(m.endList, true);
  assert.equal(m.drm, '');
});

test('HLS SAMPLE-AES / Widevine is reported as DRM', () => {
  const p = MT.parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\na.ts\n', 'https://x/');
  assert.ok(p.drm);
});

test('DASH summary detects Widevine and live', () => {
  const xml = '<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="v" width="1280" height="720" codecs="avc1.64001f" bandwidth="1"/></AdaptationSet></Period></MPD>';
  const s = MT.summarize(xml, 'https://x/a.mpd');
  assert.equal(s.drm, 'Widevine');
  assert.equal(s.live, true);
  assert.equal(s.best, 720);
});

let ffmpeg = false;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); execSync('ffprobe -version', { stdio: 'ignore' }); ffmpeg = true; } catch { /* skip */ }

test('TS -> MP4 and fMP4 video+audio merge produce valid files', { skip: !ffmpeg && 'ffmpeg not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slmt-'));
  const run = c => execSync(c, { cwd: dir, stdio: 'ignore' });
  run('ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 3 -c:v libx264 -bf 2 -g 25 -pix_fmt yuv420p -c:a aac src.mp4');
  run('ffmpeg -y -i src.mp4 -c copy -f mpegts src.ts');
  run('ffmpeg -y -i src.mp4 -an -c copy -movflags +frag_keyframe+empty_moov+default_base_moof v.mp4');
  run('ffmpeg -y -i src.mp4 -vn -c copy -movflags +frag_keyframe+empty_moov+default_base_moof a.mp4');
  const write = (name, parts) => fs.writeFileSync(path.join(dir, name), Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.length))));
  const ts = new Uint8Array(fs.readFileSync(path.join(dir, 'src.ts')));
  write('out_ts.mp4', MT.writeMp4(MT.tsToTracks(MT.demuxTs([ts]))));
  const v = new Uint8Array(fs.readFileSync(path.join(dir, 'v.mp4')));
  const a = new Uint8Array(fs.readFileSync(path.join(dir, 'a.mp4')));
  const tracks = [...MT.fmp4ToTracks(MT.parseFragments(v, MT.parseInit(v))), ...MT.fmp4ToTracks(MT.parseFragments(a, MT.parseInit(a)))];
  write('out_merge.mp4', MT.writeMp4(MT.alignTracks(tracks)));
  for (const f of ['out_ts.mp4', 'out_merge.mp4']) {
    const info = execSync(`ffprobe -v error -show_entries stream=codec_name,nb_frames -of csv=p=0 ${f}`, { cwd: dir }).toString();
    assert.match(info, /h264,75/);
    assert.match(info, /aac/);
    const errors = execSync(`ffmpeg -v error -i ${f} -f null - 2>&1`, { cwd: dir }).toString();
    assert.equal(errors.trim(), '');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
