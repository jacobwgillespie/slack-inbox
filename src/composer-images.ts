import type { SlackFile } from './slack/types'

export interface DraftImage {
  id: string
  name: string
  type: string
  uploaded?: SlackFile
}

let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('composer-images', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('images')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
}

async function imageRequest<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('images', mode)
    const request = operation(transaction.objectStore('images'))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function storePastedImage(file: File): Promise<DraftImage> {
  const id = crypto.randomUUID()
  const name = file.name || `image.${file.type.split('/')[1] || 'png'}`
  await imageRequest('readwrite', (store) => store.put(file, id))
  return { id, name, type: file.type }
}

export async function readPastedImage(id: string): Promise<Blob> {
  const blob = await imageRequest<Blob | undefined>('readonly', (store) => store.get(id))
  if (!blob) throw new Error('This pasted image is no longer available. Paste it again to attach it.')
  return blob
}

export function removePastedImage(id: string) {
  return imageRequest('readwrite', (store) => store.delete(id))
}
