import fs from "fs";
import XLSX from "xlsx";
import stringSimilarity from "string-similarity";

/**
 * Normalizes and strips titles/punctuation from dirty name entries
 */
function cleanName(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .toUpperCase()
    .replace(/\(MR\)|\(MRS\)|\(MISS\)|\(LATE\)/g, "") // Strip brackets
    .replace(/\b(MR|MRS|MISS|DR|LATE)\b/g, "") // Strip clean prefixes
    .replace(/[\.,]/g, " ") // Turn dots/commas to spaces
    .replace(/\s+/g, " ") // Remove multiple spaces
    .trim();
}

/**
 * Reads an Excel sheet and converts it to clean JSON objects
 */
function parseExcelFile(filePath, sheetIndex = 0) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[sheetIndex];
  const worksheet = workbook.Sheets[sheetName];
  // raw: false reads formatted strings, defval prevents empty keys from being omitted
  return XLSX.utils.sheet_to_json(worksheet, { raw: false, defval: "" });
}

// Executing the main processing function
function runMatchingPipeline() {
  console.log("🚀 Starting Loan-to-Member Matching Engine...");

  // 1. Load data from files
  // Change these filenames to match your local setup
  const masterRows = parseExcelFile("master_names.xlsx");
  const loanRows = parseExcelFile("loans_data.xlsx");

  // 2. Pre-process Master Members list for blazing fast comparisons
  const cleanMembers = masterRows
    .filter((row) => row["NAME"] && row["REG NO."]) // Skip total blank rows
    .map((row) => {
      const normalized = cleanName(row["NAME"]);
      return {
        regNo: row["REG NO."],
        originalName: row["NAME"],
        cleanedName: normalized,
        surname: normalized.split(" ")[0], // Primary key optimization
      };
    });

  const outputPayload = [];

  // 3. Process Loans
  let currentActiveDate = "2026-01-01"; // Default tracking state for header breaks

  for (const loan of loanRows) {
    // Safe check for section header breaks in your file (e.g., rows containing "2026-02-01")
    if (loan["PURPOSE"] && loan["PURPOSE"].includes("2026-")) {
      currentActiveDate = loan["PURPOSE"].trim();
      continue;
    }
    if (loan["DATE"] && loan["DATE"].includes("2026-")) {
      currentActiveDate = loan["DATE"].trim();
    }

    const rawLoanName = loan["NAME"];
    if (
      !rawLoanName ||
      rawLoanName === "NAME" ||
      rawLoanName.startsWith("S/N")
    ) {
      continue; // Skip embedded column header rows
    }

    const normalizedLoanName = cleanName(rawLoanName);
    const loanSurname = normalizedLoanName.split(" ")[0];

    let matchingMember = null;
    let highestConfidence = 0;

    // Dynamic Filtering: Find members sharing the same surname prefix context
    const matchingSurnameGroup = cleanMembers.filter(
      (m) => m.surname === loanSurname,
    );

    for (const member of matchingSurnameGroup) {
      // Check cross-similarity ratios
      const visualScore = stringSimilarity.compareTwoStrings(
        member.cleanedName,
        normalizedLoanName,
      );

      // Handle token inclusion check (e.g. initials "O.H" matching parts of full names)
      const memberTokens = member.cleanedName.split(" ");
      const loanTokens = normalizedLoanName.split(" ");
      const tokenMatches = loanTokens.filter(
        (t) => memberTokens.includes(t) || t.startsWith(memberTokens[0]),
      ).length;

      const totalScore = visualScore + tokenMatches * 0.15;

      if (totalScore > highestConfidence) {
        highestConfidence = totalScore;
        matchingMember = member;
      }
    }

    // 4. Verification Check Constraints
    // Strict baseline validation threshold (0.4) protects database integrity
    if (matchingMember && highestConfidence >= 0.4) {
      outputPayload.push({
        "REG NO.": matchingMember.regNo,
        "MASTER LIST NAME": matchingMember.originalName,
        "BANK TRANSACTION NAME": rawLoanName,
        "ACCOUNT NO.": loan["ACCOUNT NO."],
        BANK: loan["BANK"],
        AMOUNT: loan["AMOUNT "], // Accounts for trailing space keys in column headers
        PURPOSE: loan["PURPOSE"],
        "RECORDED DATE": currentActiveDate,
        CONFIDENCE: highestConfidence.toFixed(2),
        STATUS: "MATCHED",
      });
    } else {
      // Logs unresolved rows flag down to a verification checklist payload
      outputPayload.push({
        "REG NO.": "REQUIRES_MANUAL_REVIEW",
        "MASTER LIST NAME": "NOT FOUND",
        "BANK TRANSACTION NAME": rawLoanName,
        "ACCOUNT NO.": loan["ACCOUNT NO."],
        BANK: loan["BANK"],
        AMOUNT: loan["AMOUNT "],
        PURPOSE: loan["PURPOSE"],
        "RECORDED DATE": currentActiveDate,
        CONFIDENCE: "0.00",
        STATUS: "UNMATCHED",
      });
    }
  }

  // 5. Build and Write Consolidated Output Spreadsheet
  const newWorkbook = XLSX.utils.book_new();
  const newWorksheet = XLSX.utils.json_to_sheet(outputPayload);
  XLSX.utils.book_append_sheet(newWorkbook, newWorksheet, "Import_Ready_Loans");

  XLSX.writeFile(newWorkbook, "import_ready_payload.xlsx");
  console.log(
    "🏁 Success! Compiled database-ready sheet saved as 'import_ready_payload.xlsx'",
  );
}

runMatchingPipeline();
