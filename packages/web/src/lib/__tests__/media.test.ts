import { expect, test } from 'bun:test'
import { fileKindOf } from '../media'

test.each([
  ['song.mp3', 'audio'],
  ['a/b/TRACK.WAV', 'audio'],
  ['voice.m4a', 'audio'],
  ['clip.ogg', 'audio'],
  ['clip.oga', 'audio'],
  ['song.flac', 'audio'],
  ['song.aac', 'audio'],
  ['clip.mp4', 'video'],
  ['CLIP.MOV', 'video'],
  ['clip.m4v', 'video'],
  ['take.webm', 'webm'],
  ['photo.avif', 'image'],
  ['index.html', 'document'],
  ['clip.mp4.html', 'document'],
  ['README', 'document'],
  ['', 'document'],
  [null, 'document'],
] as const)('%s → %s', (path, kind) => {
  expect(fileKindOf(path)).toBe(kind)
})
