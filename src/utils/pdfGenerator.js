import puppeteer from 'puppeteer';

export const generatePDF = async (htmlContent, outputPath) => {
  const launchOptions = {
    headless: true,
    // Uses the Alpine system Chromium when set via env (see Dockerfile),
    // falls back to Puppeteer's own bundled browser if the env var isn't set
    // (e.g. when running locally on your machine without Alpine/Docker).
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-features=dbus'
    ]
  };

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true
    });
    return outputPath;
  } finally {
    await browser.close();
  }
};