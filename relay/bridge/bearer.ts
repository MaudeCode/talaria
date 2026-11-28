import { createHash, timingSafeEqual } from "node:crypto";

const digest = (text: string) => createHash("sha256").update(text).digest();

export function bearerVerifier(token: string) {
  const expected = digest(token);
  return (authorization: string | undefined): boolean => {
    const [scheme, presented] = (authorization ?? "").split(" ");
    return scheme === "Bearer" && !!presented && timingSafeEqual(digest(presented), expected);
  };
}
