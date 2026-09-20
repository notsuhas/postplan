import { expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { ImageView } from '../ImageView'
import { isImageFile } from '@/lib/image'

test('image controls zoom, reset, and preserve the original protected URL', () => {
  render(<ImageView src="https://content.test/_t/token/sp/site/picture.avif" fileName="picture.avif" />)
  fireEvent.load(screen.getByRole('img'))
  expect(screen.queryByText('Loading image…')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
  expect(screen.getByText('125%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }))
  expect(screen.getByText('100%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
  expect(screen.getByText('75%')).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
    'https://content.test/_t/token/sp/site/picture.avif?download=1',
  )
  expect(screen.getByRole('link', { name: 'Open original' }).getAttribute('href')).toBe(
    'https://content.test/_t/token/sp/site/picture.avif',
  )
})

test('broken images show a useful error', () => {
  render(<ImageView src="https://content.test/missing.png" fileName="missing.png" />)
  fireEvent.error(screen.getByRole('img'))
  expect(screen.getByRole('alert').textContent).toContain('Could not load')
})

test('image detection covers supported formats without treating HTML as an image', () => {
  for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico'])
    expect(isImageFile(`PHOTO.${ext.toUpperCase()}`)).toBe(true)
  expect(isImageFile('photo.png.html')).toBe(false)
})
