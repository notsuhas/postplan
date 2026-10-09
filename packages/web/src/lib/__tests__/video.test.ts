import { describe, expect, test } from 'bun:test'
import { isAudioFile } from '../audio'
import { isVideoFile, isWebmFile } from '../video'

describe('isVideoFile', () => {
  test('recognizes every extension the content worker serves as video', () => {
    for (const ext of ['mp4', 'm4v', 'mov']) expect(isVideoFile(`a/b/CLIP.${ext.toUpperCase()}`)).toBe(true)
  })
  test('leaves webm to the audio path and rejects non-video files', () => {
    expect(isVideoFile('take.webm')).toBe(false)
    expect(isAudioFile('take.webm')).toBe(true)
    expect(isVideoFile('clip.mp4.html')).toBe(false)
    expect(isVideoFile('song.mp3')).toBe(false)
    expect(isVideoFile('README')).toBe(false)
  })
})

test('isWebmFile matches only a final .webm extension', () => {
  expect(isWebmFile('Take.WEBM')).toBe(true)
  expect(isWebmFile('take.webm.html')).toBe(false)
  expect(isWebmFile('webm')).toBe(false)
})
