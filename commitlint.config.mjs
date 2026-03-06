export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
  },
}
