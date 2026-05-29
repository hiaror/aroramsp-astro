const start = new Date(2014, 3, 1);
const now = new Date();
const yrs = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
export const expYears = yrs;
export const expYearsPlus = `${yrs}+`;
