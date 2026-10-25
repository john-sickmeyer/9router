import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ success: false, message: "This Studio fork uses reviewed Git releases. Follow STUDIO.md; the stock npm updater would erase your changes." }, { status: 409 });
}
