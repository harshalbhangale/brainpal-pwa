import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ConsoleEmailSender, type EmailSender } from "@brainpal/auth";

export class SesEmailSender implements EmailSender {
  private readonly client = new SESv2Client({ region: process.env["AWS_REGION"] ?? "ap-southeast-2" });

  constructor(private readonly from: string) {}

  async sendLoginCode(email: string, code: string): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [email] },
        Content: {
          Simple: {
            Subject: { Data: `Your BrainPal code: ${code}` },
            Body: {
              Text: {
                Data:
                  `Your BrainPal sign-in code is ${code}.\n\n` +
                  "It expires in 10 minutes. If you did not ask for it, you can ignore this email.",
              },
            },
          },
        },
      }),
    );
  }
}

/**
 * SES in production; the console everywhere else. Production refuses to start
 * without SES, because the console sender would put sign-in codes in the logs.
 */
export function buildEmailSender(): EmailSender {
  if (process.env["EMAIL_PROVIDER"] === "ses") {
    return new SesEmailSender(process.env["EMAIL_FROM"] ?? "BrainPal <no-reply@brainpal.com.au>");
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("EMAIL_PROVIDER=ses is required in production");
  }
  return new ConsoleEmailSender();
}
