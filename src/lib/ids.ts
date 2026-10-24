import { v7 as uuidv7, validate, version } from 'uuid'

/** IDs UUID v7 gerados na aplicação. */
export function newId(): string {
  return uuidv7()
}

export function isUuidV7(value: string): boolean {
  return validate(value) && version(value) === 7
}
