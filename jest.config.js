module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  modulePathIgnorePatterns: [
    "<rootDir>/lib/",
    "<rootDir>/src/__tests__/context.ts",
    "<rootDir>/src/__tests__/test-utils.ts"
  ]
};
