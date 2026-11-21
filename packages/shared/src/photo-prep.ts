export const PHOTO_PREP_SKILL = 'prep_listing_photos';
export const PHOTO_PREP_IMAGE_BYTES = 96 * 1024;
export const PHOTO_PREP_BODY_LIMIT = 3 * 1024 * 1024;

export interface PhotoPrepImage {
  index: number;
  jpeg?: string;
  quality?: number;
}
export type PhotoPrepSuggestion =
  | {kind: 'hero'; order: number[]}
  | {kind: 'light'; index: number}
  | {kind: 'vin'; index: number; vin: string; matches: boolean}
  | {kind: 'mileage'; index: number; mileage: number}
  | {kind: 'damage'; index: number; note: string}
  | {kind: 'description'; text: string};
