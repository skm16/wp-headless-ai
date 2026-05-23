type ClassValue = string | number | null | undefined | false;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter((v): v is string | number => Boolean(v)).join(" ");
}
