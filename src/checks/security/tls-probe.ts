import { connect } from "node:tls";

export interface CertificateInfo {
  validTo: Date;
}

export interface InspectOptions {
  /** additional trusted CA (tests use the self-signed fixture) */
  ca?: string;
  timeoutMs?: number;
  /** default true; tests may relax */
  rejectUnauthorized?: boolean;
}

/** Open a TLS connection and read the peer certificate's expiry. */
export function inspectCertificate(
  host: string,
  port: number,
  options: InspectOptions = {},
): Promise<CertificateInfo> {
  const { ca, timeoutMs = 10_000, rejectUnauthorized = true } = options;
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host, port, servername: host, ca, rejectUnauthorized, timeout: timeoutMs },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        if (typeof certificate.valid_to !== "string" || certificate.valid_to === "") {
          reject(new Error("Peer returned no certificate validity information"));
          return;
        }
        resolve({ validTo: new Date(certificate.valid_to) });
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS connection to ${host}:${String(port)} timed out`));
    });
    socket.on("error", (error) => {
      reject(error);
    });
  });
}
