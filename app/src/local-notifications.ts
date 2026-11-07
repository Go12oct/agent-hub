export function localNotificationId(key: string): number {
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) & 0x7fffffff;
  return hash || 1;
}
