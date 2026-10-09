// The photo library (ADR 084): picture key -> its file in public/pictures. Real photos of the
// thing itself, shared by every customer; a key with no photo yet shows the line icon for its
// kind. Empty until the library's first photos are added.
export const PICTURE_PHOTOS: ReadonlyMap<string, string> = new Map<string, string>([]);
